import { PluginCallError } from '../call.ts'
import {
  ACCOUNT_CAPABILITY,
  ACCOUNT_METHOD_GROUPS,
  ACCOUNT_PLUGIN_ID,
  EMAIL_CAPABILITY,
  EMAIL_PLUGIN_ID,
  type Account,
  type AccountList,
  type AssignedMailbox,
  type MailboxImportInput,
} from './model.ts'
import {
  bool,
  integer,
  invalidAccountResponse,
  object,
  parseAccount,
  parseAccountAddressTarget,
  parseAccountMailboxTarget,
  parseAccountPage,
  parseMailboxTarget,
  string,
  timestamp,
} from './parse.ts'

type Rpc = <T>(
  id: string,
  capability: string,
  method: string,
  payload: unknown,
  parse: (value: unknown) => T,
  deadlineMs?: number,
) => Promise<T>
const DEFAULT_PAGE_SIZE = 16
const ACCOUNT_PAGE_TOO_LARGE =
  '账号列表单页数据过大，超过消息大小上限，请减少每页账号数后重试。'
const MAX_IMPORT_BYTES = 512 * 1024
const MAX_TEMPLATE_BYTES = 512 * 1024
const encoder = new TextEncoder()

export function createAccountsApi(
  call: Rpc,
  connection: () => string | null = () => null,
) {
  const accountCall = <T>(
    method: string,
    payload: unknown,
    parse: (value: unknown) => T,
    deadline?: number,
  ) => call(ACCOUNT_PLUGIN_ID, ACCOUNT_CAPABILITY, method, payload, parse, deadline)
  const emailCall = <T>(method: string, payload: unknown, parse: (value: unknown) => T) =>
    call(EMAIL_PLUGIN_ID, EMAIL_CAPABILITY, method, payload, parse)
  const importMailboxes = (input: MailboxImportInput) => {
    if (
      !input.mailboxes.length ||
      input.mailboxes.length > 2000 ||
      new Set(input.mailboxes.map((item) => item.mailboxId)).size !==
        input.mailboxes.length ||
      new Set(input.mailboxes.map((item) => item.email.trim().toLowerCase())).size !==
        input.mailboxes.length ||
      new Set(input.expectedDuplicateIds).size !== input.expectedDuplicateIds.length ||
      input.mailboxes.some(
        (item) =>
          !item.mailboxId ||
          item.email.length > 190 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email),
      )
    )
      throw new Error('邮箱选择列表无效')
    const payload = {
      mailboxes: input.mailboxes.map(({ mailboxId, email }) => ({ mailboxId, email })),
      loginMethod: input.loginMethod,
      phone: input.phone,
      emailOtpUrl: input.emailOtpUrl,
      smsOtpUrl: input.smsOtpUrl,
      status: input.status,
      homepageUrl: input.homepageUrl,
      note: input.note,
      expectedDuplicateIds: [...input.expectedDuplicateIds],
    }
    return accountCall('vinted.accounts.mailbox.import', payload, (value) => {
      const row = object(value)
      const total = integer(row.total)
      const inserted = integer(row.inserted)
      const skipped = integer(row.skipped)
      if (total !== payload.mailboxes.length || inserted + skipped !== total)
        throw invalidAccountResponse('邮箱导入结果不一致')
      return { total, inserted, skipped }
    })
  }
  const assertAccountScope = (scope: string | null) => {
    if (connection() !== scope) throw new Error('Workspace 已切换，账号列表已丢弃')
  }
  const readAccountPages = async (
    pageSize: number,
    scope: string | null,
  ): Promise<AccountList> => {
    assertAccountScope(scope)
    const first = await accountCall(
      'vinted.accounts.list',
      { page: 1, pageSize },
      (value) => parseAccountPage(value, 1, pageSize),
    )
    assertAccountScope(scope)
    const pages = Math.max(1, Math.ceil(first.total / pageSize))
    const items = [...first.items]
    const bindings = [...first.bindings]
    const accountIds = new Set(items.map((item) => item.id))
    const windows = new Set(bindings.map((item) => item.windowId))
    for (let page = 2; page <= pages; page++) {
      const next = await accountCall(
        'vinted.accounts.list',
        { page, pageSize, revision: first.revision },
        (value) => parseAccountPage(value, page, pageSize),
      )
      assertAccountScope(scope)
      if (
        next.revision !== first.revision ||
        next.total !== first.total ||
        next.storageDurable !== first.storageDurable
      )
        throw new Error('账号列表已变化，请刷新后重试。')
      for (const item of next.items) {
        if (accountIds.has(item.id))
          throw invalidAccountResponse('账号列表包含重复标识，请刷新后重试。')
        accountIds.add(item.id)
      }
      const pageIds = new Set(next.items.map((item) => item.id))
      for (const binding of next.bindings) {
        if (!pageIds.has(binding.accountId) || windows.has(binding.windowId))
          throw invalidAccountResponse('窗口关联数据无效，请刷新后重试。')
        windows.add(binding.windowId)
      }
      items.push(...next.items)
      bindings.push(...next.bindings)
    }
    if (items.length !== first.total)
      throw invalidAccountResponse('账号列表读取不完整，请刷新后重试。')
    return { items, bindings, total: first.total, storageDurable: first.storageDurable }
  }
  return {
    async listAccounts(pageSize = DEFAULT_PAGE_SIZE): Promise<AccountList> {
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > DEFAULT_PAGE_SIZE)
        throw new Error('账号页大小无效')
      const scope = connection()
      for (let size = pageSize; ; size = Math.max(1, Math.floor(size / 2))) {
        try {
          return await readAccountPages(size, scope)
        } catch (error) {
          assertAccountScope(scope)
          if (
            size === 1 ||
            !(error instanceof PluginCallError) ||
            error.code !== 'UNAVAILABLE' ||
            error.message !== ACCOUNT_PAGE_TOO_LARGE
          )
            throw error
        }
      }
    },
    saveAccount(input: {
      id?: string
      expectedUpdatedAt?: string
      loginMethod: Account['loginMethod']
      account: string
      password: string
      phone: string
      emailOtpUrl: string
      smsOtpUrl: string
      note: string
      status: Account['status']
      homepageUrl: string
    }): Promise<{ item: Account; created: boolean }> {
      const {
        id,
        expectedUpdatedAt,
        loginMethod,
        account,
        password,
        phone,
        emailOtpUrl,
        smsOtpUrl,
        note,
        status,
        homepageUrl,
      } = input
      const fields = {
        loginMethod,
        account,
        password,
        phone,
        emailOtpUrl,
        smsOtpUrl,
        note,
        status,
        homepageUrl,
      }
      return accountCall(
        'vinted.accounts.save',
        { ...(id ? { id, expectedUpdatedAt } : {}), ...fields },
        (value) => {
          const row = object(value)
          if (typeof row.created !== 'boolean') throw invalidAccountResponse()
          const item = parseAccount(row.item)
          if (id && item.id !== id) throw invalidAccountResponse('账号保存返回标识不一致')
          return { item, created: row.created }
        },
      )
    },
    removeAccount: (accountId: string) =>
      accountCall('vinted.accounts.remove', { accountId }, (value) => {
        const row = object(value)
        if (row.removed !== true || row.accountId !== accountId)
          throw invalidAccountResponse('账号删除未确认，请刷新列表核对')
        return { removed: true as const }
      }),
    importAccounts: async (
      filename: string,
      content: { text: string } | { base64: string },
    ) => {
      const size =
        'text' in content
          ? encoder.encode(content.text).byteLength
          : Math.ceil(content.base64.length * 0.75)
      if (
        !filename.trim() ||
        size < 1 ||
        size > MAX_IMPORT_BYTES ||
        ('base64' in content && content.base64.length > MAX_IMPORT_BYTES)
      )
        throw new Error('请选择有效的 CSV/XLSX 文件，大小不超过 512 KiB')
      return accountCall('vinted.accounts.import', { filename, ...content }, (value) => {
        const row = object(value)
        const errors = Array.isArray(row.errors) ? row.errors : null
        if (!errors || errors.length > 50)
          throw invalidAccountResponse('账号导入结果无效')
        const total = integer(row.total)
        const inserted = integer(row.inserted)
        const updated = integer(row.updated)
        const skipped = integer(row.skipped)
        if (inserted + updated + skipped !== total)
          throw invalidAccountResponse('账号导入计数无效')
        return {
          total,
          inserted,
          updated,
          skipped,
          errors: errors.map((item) => {
            const error = object(item)
            return { row: integer(error.row, 1), message: string(error.message, 500) }
          }),
        }
      })
    },
    template: (format: 'csv' | 'xlsx') =>
      accountCall('vinted.accounts.template', { format }, (value) => {
        const row = object(value)
        const filename = string(row.filename, 200)
        const mimeType = string(row.mimeType, 128)
        const base64 = string(row.base64, MAX_TEMPLATE_BYTES)
        if (
          !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) ||
          base64.length === 0 ||
          (format === 'csv' && !filename.endsWith('.csv')) ||
          (format === 'xlsx' && !filename.endsWith('.xlsx'))
        )
          throw invalidAccountResponse('账号模板返回无效')
        return { filename, mimeType, base64 }
      }),
    readOtp: (accountId: string, channel: 'email' | 'sms', expectedUpdatedAt?: string) =>
      accountCall(
        'vinted.accounts.otp',
        {
          accountId,
          channel,
          ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
        },
        (value) => {
          const row = object(value)
          const body = string(row.body, 64 * 1024)
          const code = row.code === null ? null : string(row.code, 6)
          if (
            row.channel !== channel ||
            (code !== null && !/^\d{4}(?:\d{2})?$/.test(code)) ||
            typeof row.truncated !== 'boolean'
          )
            throw invalidAccountResponse('验证码读取结果无效')
          return {
            channel,
            code,
            body,
            truncated: row.truncated,
            contentType: string(row.contentType, 256),
            fetchedAt: timestamp(row.fetchedAt)!,
          }
        },
      ),
    bindings: () =>
      accountCall('vinted.accounts.bindings', {}, (value) => {
        const row = object(value)
        if (!Array.isArray(row.items)) throw invalidAccountResponse('账号关联列表无效')
        return {
          items: row.items.map((entry) => {
            const item = object(entry)
            const nested = item.account === null ? null : object(item.account)
            return {
              windowId: string(item.windowId, 64),
              accountId: string(item.accountId, 64),
              boundAt: timestamp(item.boundAt)!,
              ...(item.revision === undefined
                ? {}
                : { revision: string(item.revision, 128) }),
              account:
                nested === null
                  ? null
                  : {
                      id: string(nested.id, 64),
                      account: string(nested.account, 190),
                      loginMethod: string(nested.loginMethod, 16),
                      status: string(nested.status, 16),
                      note: string(nested.note, 200),
                    },
            }
          }),
        }
      }),
    bindAccount: async (
      accountId: string,
      windowId: string,
      confirmDuplicates = false,
      expected?: { windowAccountId: string | null; duplicateWindowIds: string[] },
    ) => {
      const result = await accountCall(
        'vinted.accounts.bind',
        {
          accountId,
          windowId,
          ...(confirmDuplicates ? { confirmDuplicates: true } : {}),
          ...(expected === undefined ? {} : { expected }),
        },
        (value) => {
          const row = object(value)
          if (
            typeof row.bound !== 'boolean' ||
            !Array.isArray(row.duplicates) ||
            !row.duplicates.every((item) => typeof item === 'string')
          )
            throw invalidAccountResponse('窗口关联结果无效')
          if (row.bound) {
            const binding = object(row.binding)
            if (
              binding.accountId !== accountId ||
              binding.windowId !== windowId ||
              !string(binding.revision, 128)
            )
              throw invalidAccountResponse('Profile 绑定未确认，请刷新后核对')
            timestamp(binding.boundAt)
          }
          return { bound: row.bound, duplicates: row.duplicates as string[] }
        },
      )
      return result
    },
    unbindWindow: (windowId: string) =>
      accountCall('vinted.accounts.unbind', { windowId }, (value) => {
        const row = object(value)
        if (row.windowId !== windowId || typeof row.unbound !== 'boolean')
          throw invalidAccountResponse()
        return { unbound: row.unbound }
      }),
    mailboxTargets: (query: string, page = 1, pageSize = 20) =>
      accountCall(
        'vinted.accounts.mailbox.targets',
        { query, page, pageSize },
        (value) => {
          const row = object(value)
          if (!Array.isArray(row.items)) throw invalidAccountResponse()
          const items = row.items.map((item) => parseAccountMailboxTarget(item))
          if (
            items.length > pageSize ||
            integer(row.page) !== page ||
            integer(row.pageSize) !== pageSize ||
            typeof row.storageDurable !== 'boolean'
          )
            throw invalidAccountResponse()
          return {
            items,
            total: integer(row.total),
            page,
            pageSize,
            storageDurable: row.storageDurable,
          }
        },
      ),
    assignMailbox: (
      accountId: string,
      mailbox: Omit<AssignedMailbox, 'linkedAt'> | null,
      expectedMailboxId: string | null,
    ) =>
      accountCall(
        'vinted.accounts.mailbox.set',
        { accountId, mailbox, expectedMailboxId },
        (value) => {
          const row = object(value)
          const updatedAt = timestamp(row.updatedAt)!
          if (typeof row.storageDurable !== 'boolean') throw invalidAccountResponse()
          const saved =
            row.mailbox === null
              ? null
              : parseAccountMailboxTarget({
                  id: accountId,
                  account: '',
                  status: 'unknown',
                  mailbox: row.mailbox,
                }).mailbox
          if (
            (saved?.mailboxId ?? null) !== (mailbox?.mailboxId ?? null) ||
            (saved?.email.toLowerCase() ?? null) !==
              (mailbox?.email.toLowerCase() ?? null)
          )
            throw invalidAccountResponse('邮箱关联未确认，请刷新账号列表')
          return { mailbox: saved, updatedAt, storageDurable: row.storageDurable }
        },
      ),
    mailboxImport: importMailboxes,
    importMailboxes,
    emailTargets: (query = '', page = 1, pageSize = 20) =>
      emailCall('email.accounts.targets', { query, page, pageSize }, (value) => {
        const row = object(value)
        if (!Array.isArray(row.items)) throw new Error('邮箱选择列表无效')
        const items = row.items.map(parseMailboxTarget)
        if (
          items.length > pageSize ||
          integer(row.page) !== page ||
          integer(row.pageSize) !== pageSize ||
          typeof row.storageDurable !== 'boolean'
        )
          throw new Error('邮箱选择列表分页无效')
        return {
          items,
          total: integer(row.total),
          page,
          pageSize,
          storageDurable: row.storageDurable,
        }
      }),
    async emailTargetsAll(query = '') {
      const first = await this.emailTargets(query, 1, 50)
      const items = [...first.items]
      const pages = Math.ceil(first.total / 50)
      for (let page = 2; page <= pages; page++) {
        const next = await this.emailTargets(query, page, 50)
        if (next.total !== first.total || next.storageDurable !== first.storageDurable)
          throw new Error('邮箱列表已变化，请刷新后重试')
        items.push(...next.items)
      }
      if (
        items.length !== first.total ||
        new Set(items.map((item) => item.id)).size !== items.length
      )
        throw new Error('邮箱列表读取不完整，请刷新后重试')
      return items
    },
    addressTargets: (query = '', page = 1, pageSize = 20) =>
      accountCall(
        'vinted.accounts.address.targets',
        { query, page, pageSize },
        (value) => {
          const row = object(value)
          if (!Array.isArray(row.items)) throw invalidAccountResponse()
          return {
            items: row.items.map(parseAccountAddressTarget),
            total: integer(row.total),
            page: integer(row.page, 1),
            pageSize: integer(row.pageSize, 1),
            storageDurable: bool(row.storageDurable),
          }
        },
      ),
    saveAddress: (
      accountId: string,
      profile: Omit<NonNullable<Account['address']>, 'linkedAt'> | null,
      expectedProfileId?: string | null,
    ) =>
      accountCall(
        'vinted.accounts.address.set',
        {
          accountId,
          profile,
          ...(expectedProfileId === undefined ? {} : { expectedProfileId }),
        },
        (value) => {
          const row = object(value)
          const updatedAt = timestamp(row.updatedAt)!
          const storageDurable = bool(row.storageDurable)
          const address =
            row.address === null
              ? null
              : parseAccountAddressTarget({
                  id: accountId,
                  account: '',
                  status: 'unknown',
                  address: row.address,
                }).address
          if ((address?.id ?? null) !== (profile?.id ?? null))
            throw invalidAccountResponse('账号地址关联未确认')
          return { address, updatedAt, storageDurable }
        },
      ),
    orderWatchSettings: () =>
      accountCall('vinted.accounts.orders.settings.get', {}, (value) => {
        const row = object(value)
        const intervalMinutes = integer(row.intervalMinutes, 5)
        const bark = object(row.bark)
        if (intervalMinutes > 1440) throw invalidAccountResponse()
        return {
          intervalMinutes,
          bark: {
            baseUrl: string(bark.baseUrl, 500),
            deviceKey: string(bark.deviceKey, 256),
            enabled: bool(bark.enabled),
          },
        }
      }),
    saveOrderWatchSettings: (input: {
      intervalMinutes: number
      bark: { baseUrl: string; deviceKey: string; enabled: boolean }
    }) =>
      accountCall('vinted.accounts.orders.settings.save', input, (value) => {
        const row = object(value)
        const intervalMinutes = integer(row.intervalMinutes, 5)
        const bark = object(row.bark)
        if (intervalMinutes > 1440) throw invalidAccountResponse()
        return {
          intervalMinutes,
          bark: {
            baseUrl: string(bark.baseUrl, 500),
            deviceKey: string(bark.deviceKey, 256),
            enabled: bool(bark.enabled),
          },
        }
      }),
    testOrderWatchBark: () =>
      accountCall('vinted.accounts.orders.bark.test', {}, (value) => {
        const row = object(value)
        if (row.sent !== true) throw invalidAccountResponse('Bark 测试未确认')
        return { sent: true as const }
      }),
    orderWatches: () =>
      accountCall('vinted.accounts.orders.list', {}, (value) => {
        const row = object(value)
        if (!Array.isArray(row.items)) throw invalidAccountResponse()
        return {
          items: row.items.map((entry) => {
            const item = object(entry)
            return {
              accountId: string(item.accountId, 64),
              homepageUrl: string(item.homepageUrl, 2048),
              enabled: bool(item.enabled),
              running: bool(item.running),
              lastCompleteAt: timestamp(item.lastCompleteAt, true),
              lastItemCount:
                item.lastItemCount === null ? null : integer(item.lastItemCount),
              lastError: item.lastError === null ? null : string(item.lastError, 500),
              nextRunAt: timestamp(item.nextRunAt, true),
              pendingCount: integer(item.pendingCount),
              soldCount: integer(item.soldCount),
            }
          }),
        }
      }),
    orderWatchHistory: (accountId: string) =>
      accountCall('vinted.accounts.orders.list', { accountId }, (value) => {
        const row = object(value)
        if (!Array.isArray(row.items) || row.items.length !== 1)
          throw invalidAccountResponse('监控记录不存在，请刷新后重试')
        const item = object(row.items[0])
        if (
          item.accountId !== accountId ||
          !Array.isArray(item.candidates) ||
          item.candidates.length > 100
        )
          throw invalidAccountResponse()
        return item.candidates.map((entry) => {
          const candidate = object(entry)
          const status = string(candidate.status, 16)
          if (!['pending', 'sold', 'reappeared'].includes(status))
            throw invalidAccountResponse()
          const itemId = string(candidate.itemId, 32)
          if (!/^\d{1,32}$/.test(itemId)) throw invalidAccountResponse()
          return {
            id: string(candidate.id, 64),
            itemId,
            itemUrl: string(candidate.itemUrl, 2048),
            title: string(candidate.title, 500),
            status: status as 'pending' | 'sold' | 'reappeared',
            lastSeenAt: timestamp(candidate.lastSeenAt, true),
            missingAt: timestamp(candidate.missingAt)!,
            checkedAt: timestamp(candidate.checkedAt, true),
            checkError:
              candidate.checkError === null ? null : string(candidate.checkError, 500),
            notifiedAt: timestamp(candidate.notifiedAt, true),
            notifyError:
              candidate.notifyError === null ? null : string(candidate.notifyError, 500),
          }
        })
      }),
    orderWatchItems: (accountId: string, page: number) =>
      accountCall(
        'vinted.accounts.orders.items',
        { accountId, page, pageSize: 10 },
        (value) => {
          const row = object(value)
          if (!Array.isArray(row.items) || row.page !== page || row.pageSize !== 10)
            throw invalidAccountResponse()
          return {
            items: row.items.map((entry) => {
              const item = object(entry)
              const id = string(item.id, 32)
              if (!/^\d{1,32}$/.test(id)) throw invalidAccountResponse()
              return {
                id,
                url: string(item.url, 2048),
                title: string(item.title, 500),
                imageUrl: item.imageUrl === null ? null : string(item.imageUrl, 2048),
              }
            }),
            total: integer(row.total),
            page,
            pageSize: 10,
            lastCompleteAt: timestamp(row.lastCompleteAt, true),
            lastError: row.lastError === null ? null : string(row.lastError, 500),
          }
        },
      ),
    runOrderWatch: (accountId: string) =>
      accountCall('vinted.accounts.orders.run', { accountId }, (value) => {
        const row = object(value)
        return { queued: bool(row.queued) }
      }),
    setOrderWatchEnabled: (accountId: string, enabled: boolean) =>
      accountCall('vinted.accounts.orders.enabled', { accountId, enabled }, (value) => {
        const row = object(value)
        if (row.enabled !== enabled) throw invalidAccountResponse()
        return { enabled }
      }),
  }
}

const hostRpc: Rpc = (id, capability, method, payload, parse, deadlineMs) =>
  import('../call.ts').then(({ callPlugin }) =>
    callPlugin(id, capability, method, payload, parse, deadlineMs),
  )
export const accountsApi = createAccountsApi(hostRpc)

export function supportsAccountBase(
  plugin:
    | {
        capabilities: readonly string[]
        granted: readonly string[]
        methods: readonly string[]
        enabled: boolean
        state: string
      }
    | undefined,
) {
  return (
    !!plugin &&
    plugin.enabled &&
    plugin.state === 'running' &&
    plugin.capabilities.includes(ACCOUNT_CAPABILITY) &&
    plugin.granted.includes(ACCOUNT_CAPABILITY) &&
    ACCOUNT_METHOD_GROUPS.base.every((method) => plugin.methods.includes(method))
  )
}

export function supportsAccountOptional(
  plugin: { methods: readonly string[] } | undefined,
  group: Exclude<keyof typeof ACCOUNT_METHOD_GROUPS, 'base'>,
) {
  return (
    !!plugin &&
    ACCOUNT_METHOD_GROUPS[group].every((method) => plugin.methods.includes(method))
  )
}
