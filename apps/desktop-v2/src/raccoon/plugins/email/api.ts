import {
  EMAIL_CAPABILITY,
  EMAIL_METHODS,
  EMAIL_PLUGIN_ID,
  type EmailAuthorizationResult,
  type EmailSettings,
  type MailboxInput,
  type MailboxQuery,
  type MailMessageDetail,
  type MailMessagePage,
  type MailReadState,
  type MailTransport,
  type MailboxIdentity,
  type MailboxExportFile,
} from './model.ts'
import {
  integer,
  invalidEmailResponse,
  object,
  parseAuthorizationChallenge,
  parseAuthorizationResult,
  parseMailbox,
  parseMailboxPage,
  parseMessageDetail,
  parseMessagePage,
  parseSettings,
  sanitizeMailbox,
  string,
  validateMailboxInput,
} from './parse.ts'

type Rpc = <T>(
  id: string,
  capability: string,
  method: string,
  payload: unknown,
  parse: (value: unknown) => T,
  deadlineMs?: number,
) => Promise<T>
const utf8 = new TextEncoder()

export function createEmailApi(rpc: Rpc) {
  const call = <T>(
    method: string,
    payload: unknown,
    parse: (value: unknown) => T,
    deadline = 30_000,
  ) =>
    rpc(EMAIL_PLUGIN_ID, EMAIL_CAPABILITY, method, payload, parse, deadline).catch(
      (cause: unknown) => {
        const code =
          cause && typeof cause === 'object' && 'code' in cause ? cause.code : null
        const messages: Record<string, string> = {
          AUTH_FAILED: '邮箱授权失效，请重新授权后重试。',
          PERMISSION_DENIED: '邮箱权限不足，请检查插件授权。',
          RATE_LIMITED: '邮箱请求过于频繁，请稍后重试。',
          TIMEOUT: '邮箱请求超时，请检查网络后重试。',
          NOT_CONFIGURED: '邮箱配置不完整，请检查资料与授权。',
        }
        const exportMessages = [
          '导出选择包含重复邮箱，请重新选择',
          '所选邮箱已变化，请刷新后重新确认导出',
          '所选邮箱资料无法使用四段格式导出，请检查换行或分隔符',
          '导出资料超过 512 KiB，请减少选择后重试',
        ]
        if (
          method === 'email.accounts.export' &&
          cause instanceof Error &&
          exportMessages.includes(cause.message)
        )
          throw new Error(cause.message)
        throw new Error(
          typeof code === 'string' && messages[code]
            ? messages[code]
            : '邮箱操作未成功，请检查资料、授权和应用代理后重试。',
        )
      },
    )
  return {
    listMailboxes: (input: MailboxQuery) =>
      call('email.accounts.list', input, (value) => parseMailboxPage(value, input)),
    getMailbox: (id: string) =>
      call('email.accounts.get', { id }, (value) => {
        const item = parseMailbox(value)
        if (item.id !== id) throw invalidEmailResponse('邮箱标识不匹配')
        return sanitizeMailbox(item)
      }),
    saveMailbox: (input: MailboxInput) => {
      const safe = validateMailboxInput(input)
      const { password, refreshToken, ...fields } = safe
      const payload = {
        ...fields,
        ...(password?.trim() ? { password } : {}),
        ...(refreshToken?.trim() ? { refreshToken: refreshToken.trim() } : {}),
      }
      return call('email.accounts.save', payload, (value) => {
        const item = parseMailbox(value)
        if (input.id && item.id !== input.id) throw invalidEmailResponse('邮箱保存未确认')
        return sanitizeMailbox(item)
      })
    },
    importMailboxes: (text: string, transport: MailTransport) => {
      if (
        !text.trim() ||
        utf8.encode(text).byteLength > 512 * 1024 ||
        !['graph', 'imap'].includes(transport)
      )
        throw new Error('请输入有效邮箱资料，单次导入不超过 512 KiB')
      return call('email.accounts.import', { text, transport }, (value) => {
        const row = object(value)
        if (!Array.isArray(row.errors) || row.errors.length > 50)
          throw invalidEmailResponse()
        const total = integer(row.total, 0, 500)
        const inserted = integer(row.inserted)
        const skipped = integer(row.skipped)
        if (inserted + skipped !== total) throw invalidEmailResponse()
        return {
          total,
          inserted,
          skipped,
          errors: row.errors.map((entry) => {
            const item = object(entry)
            string(item.message, 500)
            const knownMessages = [
              '邮箱已存在，已保留现有凭据',
              '邮箱数量已达上限',
              '需要有效的邮箱、密码、client_id 和 refresh_token，以 ---- 分隔',
            ]
            return {
              row: integer(item.row, 1),
              message: knownMessages.includes(String(item.message))
                ? String(item.message)
                : '此行资料无效，请检查四段格式及重复邮箱。',
            }
          }),
        }
      })
    },
    exportMailboxes: (mailboxes: MailboxIdentity[]) => {
      if (
        !mailboxes.length ||
        mailboxes.length > 100 ||
        new Set(mailboxes.map((item) => item.id)).size !== mailboxes.length
      )
        throw new Error('每批请选择 1–100 个不重复邮箱导出')
      return call(
        'email.accounts.export',
        {
          mailboxes: mailboxes.map(({ id, email }) => ({ id, email })),
        },
        (value): { total: number; files: MailboxExportFile[] } => {
          const result = object(value)
          if (
            result.total !== mailboxes.length ||
            !Array.isArray(result.files) ||
            !result.files.length ||
            result.files.length > 2 ||
            utf8.encode(JSON.stringify(value)).byteLength > 512 * 1024
          )
            throw invalidEmailResponse()
          const files = result.files.map((entry): MailboxExportFile => {
            const file = object(entry)
            if (
              (file.transport !== 'graph' && file.transport !== 'imap') ||
              file.filename !== `mailboxes-${String(file.transport)}.txt`
            )
              throw invalidEmailResponse()
            const text = string(file.text, 512 * 1024, 1)
            const count = integer(file.count, 1, 100)
            const lines = text.trimEnd().split('\n')
            if (
              lines.length !== count ||
              lines.some((line) => line.split('----').length !== 4)
            )
              throw invalidEmailResponse()
            return {
              filename: file.filename as string,
              transport: file.transport,
              count,
              text,
            }
          })
          const emails = files.flatMap((file) =>
            file.text
              .trimEnd()
              .split('\n')
              .map((line) => line.split('----')[0]!.toLowerCase()),
          )
          if (
            new Set(files.map((file) => file.transport)).size !== files.length ||
            new Set(emails).size !== mailboxes.length ||
            files.reduce((sum, file) => sum + file.count, 0) !== mailboxes.length ||
            mailboxes.some((item) => !emails.includes(item.email.toLowerCase()))
          )
            throw invalidEmailResponse()
          return { total: mailboxes.length, files }
        },
      )
    },
    removeMailbox: (id: string) =>
      call('email.accounts.remove', { id }, (value) => {
        const row = object(value)
        if (row.removed !== true) throw invalidEmailResponse('邮箱删除未确认')
        return { removed: true as const }
      }),
    queueRefresh: (ids: string[]) => queue('email.refresh.queue', ids),
    queueReceive: (ids: string[]) => queue('email.receive.queue', ids),
    settings: () => call('email.settings.get', {}, parseSettings),
    saveSettings: (value: EmailSettings) =>
      call('email.settings.save', parseSettings(value), parseSettings),
    listMessages: (input: {
      accountId: string
      expectedEmail?: string
      folder: 'inbox' | 'junkemail'
      cursor?: string
      readState?: MailReadState
    }) => {
      if (
        !['inbox', 'junkemail'].includes(input.folder) ||
        (input.cursor !== undefined && input.cursor.length > 16_384) ||
        (input.readState !== undefined &&
          !['all', 'read', 'unread'].includes(input.readState))
      )
        throw new Error('邮件查询条件无效')
      return call<MailMessagePage>(
        'email.messages.list',
        input,
        (value) => parseMessagePage(value, input.readState),
        120_000,
      )
    },
    getMessage: (input: {
      accountId: string
      expectedEmail?: string
      folder: 'inbox' | 'junkemail'
      messageId: string
    }) =>
      call<MailMessageDetail>(
        'email.messages.get',
        input,
        (value) => parseMessageDetail(value, input.messageId),
        120_000,
      ),
    setMessagesRead: (input: {
      accountId: string
      expectedEmail?: string
      folder: 'inbox' | 'junkemail'
      messageIds: string[]
      isRead: boolean
    }) => {
      if (
        !input.messageIds.length ||
        input.messageIds.length > 20 ||
        new Set(input.messageIds).size !== input.messageIds.length ||
        input.messageIds.some((id) => !id || id.length > 2048)
      )
        throw new Error('每批请选择 1–20 封不重复邮件')
      return call(
        'email.messages.read',
        input,
        (value) => {
          const row = object(value)
          if (
            row.isRead !== input.isRead ||
            !Array.isArray(row.updatedIds) ||
            !Array.isArray(row.failures) ||
            row.updatedIds.length > 20 ||
            row.failures.length > 20
          )
            throw invalidEmailResponse('已读写入结果无效')
          const updatedIds = row.updatedIds.map((id) => string(id, 2048, 1))
          const failures = row.failures.map((failure) => {
            const item = object(failure)
            const code = string(item.code, 64)
            if (
              ![
                'INVALID_REQUEST',
                'PERMISSION_DENIED',
                'NOT_CONFIGURED',
                'UNAVAILABLE',
                'RATE_LIMITED',
                'TIMEOUT',
                'CANCELLED',
                'AUTH_FAILED',
                'PROTOCOL_ERROR',
              ].includes(code)
            )
              throw invalidEmailResponse()
            return { messageId: string(item.messageId, 2048, 1), code }
          })
          const returned = [...updatedIds, ...failures.map((item) => item.messageId)]
          if (
            returned.length !== input.messageIds.length ||
            new Set(returned).size !== returned.length ||
            returned.some((id) => !input.messageIds.includes(id))
          )
            throw invalidEmailResponse('邮件已读结果未覆盖当前请求')
          return { updatedIds, failures, isRead: input.isRead }
        },
        120_000,
      )
    },
    startAuthorization: (accountId: string, expectedEmail: string) =>
      call(
        'email.authorization.start',
        { accountId, expectedEmail, transport: 'graph' },
        parseAuthorizationChallenge,
        60_000,
      ),
    pollAuthorization: (
      authorizationId: string,
      accountId: string,
    ): Promise<EmailAuthorizationResult> =>
      call(
        'email.authorization.poll',
        { authorizationId },
        (value) => parseAuthorizationResult(value, accountId),
        60_000,
      ),
    cancelAuthorization: (authorizationId: string) =>
      call('email.authorization.cancel', { authorizationId }, (value) => {
        const row = object(value)
        if (row.cancelled !== true) throw invalidEmailResponse('取消授权未确认')
        return true
      }),
    supports: (
      plugin: { methods: readonly string[] } | undefined,
      group: keyof typeof EMAIL_METHODS = 'base',
    ) =>
      !!plugin && EMAIL_METHODS[group].every((method) => plugin.methods.includes(method)),
  }

  function queue(method: 'email.refresh.queue' | 'email.receive.queue', ids: string[]) {
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length)
      throw new Error('每批请选择 1–100 个不重复邮箱')
    return call(method, { ids }, (value) => {
      const row = object(value)
      const queued = integer(row.queued)
      const skipped = integer(row.skipped)
      if (queued + skipped !== ids.length) throw invalidEmailResponse('队列结果不一致')
      return { queued, skipped }
    })
  }
}

const hostRpc: Rpc = (id, capability, method, payload, parse, deadlineMs) =>
  import('../call.ts').then(({ callPlugin }) =>
    callPlugin(id, capability, method, payload, parse, deadlineMs),
  )
export const emailApi = createEmailApi(hostRpc)

export function supportsEmailReader(
  plugin:
    | {
        enabled: boolean
        state: string
        capabilities: readonly string[]
        granted: readonly string[]
        methods: readonly string[]
      }
    | undefined,
) {
  return (
    !!plugin &&
    plugin.enabled &&
    plugin.state === 'running' &&
    plugin.capabilities.includes(EMAIL_CAPABILITY) &&
    plugin.granted.includes(EMAIL_CAPABILITY) &&
    [
      'email.accounts.get',
      'email.messages.list',
      'email.messages.get',
      'email.messages.read',
    ].every((method) => plugin.methods.includes(method))
  )
}

export function supportsEmailBase(
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
    plugin.capabilities.includes(EMAIL_CAPABILITY) &&
    plugin.granted.includes(EMAIL_CAPABILITY) &&
    EMAIL_METHODS.base.every((method) => plugin.methods.includes(method))
  )
}
