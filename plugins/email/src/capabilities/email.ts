import { randomUUID } from 'node:crypto'
import {
  CONFIGURATION_METHODS,
  createConfigurationTransfer,
} from '@nexus/plugin-sdk/configuration'
import {
  PluginFailure,
  cancelled,
  invalidRequest,
  isPluginFailure,
  requiresAuthorization,
} from '../domain/errors.js'
import { parseMailboxImport } from '../domain/import.js'
import {
  EmptyInputSchema,
  FolderCountsSchema,
  IdInputSchema,
  ImportInputSchema,
  ListInputSchema,
  MAX_IMPORT_ERRORS,
  MAX_MAILBOXES,
  MessageGetInputSchema,
  MessageListInputSchema,
  MessageReadInputSchema,
  ReceiveInputSchema,
  RefreshInputSchema,
  SaveInputSchema,
  SettingsSchema,
  TargetsInputSchema,
  parseInput,
  type SaveInput,
} from '../domain/schemas.js'
import type {
  EmailSettings,
  ImportReport,
  MailboxRecord,
  MailboxView,
} from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import { safeMailFailure, withSignal } from '../services/operations.js'
import { ReceptionCoordinator } from '../services/reception.js'
import {
  RefreshCoordinator,
  findMailbox,
  nextRefresh,
  type ProviderRegistry,
} from '../services/refresh.js'
import {
  emptyReception,
  type EmailStore,
  type StoreDocument,
} from '../store/private-store.js'

export const EMAIL_METHODS = [
  'email.accounts.list',
  'email.accounts.get',
  'email.accounts.targets',
  'email.accounts.save',
  'email.accounts.import',
  'email.accounts.remove',
  'email.refresh.queue',
  'email.receive.queue',
  'email.settings.get',
  'email.settings.save',
  'email.messages.list',
  'email.messages.get',
  'email.messages.read',
  ...CONFIGURATION_METHODS,
] as const

export interface EmailServiceOptions {
  store: EmailStore
  providers: ProviderRegistry
  logger: Logger
  now?: () => Date
}

export class EmailService {
  private readonly store: EmailStore
  private readonly providers: ProviderRegistry
  private readonly now: () => Date
  private readonly refresh: RefreshCoordinator
  private readonly reception: ReceptionCoordinator
  private readonly mailboxScopes = new Map<string, AbortController>()

  constructor(options: EmailServiceOptions) {
    this.store = options.store
    this.providers = options.providers
    this.now = options.now ?? (() => new Date())
    this.refresh = new RefreshCoordinator(
      this.store,
      this.providers,
      options.logger,
      this.now,
    )
    this.reception = new ReceptionCoordinator(
      this.store,
      this.providers,
      this.refresh,
      options.logger,
      this.now,
    )
  }

  start(): void {
    this.refresh.start()
    this.reception.start()
  }
  async stop(): Promise<void> {
    for (const scope of this.mailboxScopes.values()) scope.abort(cancelled())
    this.mailboxScopes.clear()
    await Promise.all([this.refresh.stop(), this.reception.stop()])
  }
  async tick(): Promise<void> {
    await Promise.all([this.refresh.tick(), this.reception.tick()])
  }
  status(): Record<string, unknown> {
    return { storageDurable: this.store.durable }
  }

  async call(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    if (context.capability !== 'email.provider')
      throw new PluginFailure('PERMISSION_DENIED', '邮箱插件未声明此能力')
    switch (context.method) {
      case 'configuration.export':
      case 'configuration.validate':
      case 'configuration.import':
        return createConfigurationTransfer({
          schema: SettingsSchema,
          read: async () => (await this.store.read()).settings,
          apply: (settings) => this.saveSettings(settings, context.assertAlive),
          invalid: invalidRequest,
        }).call(context)
      case 'email.accounts.list': {
        const input = parseInput(ListInputSchema, context.payload)
        const document = await this.store.read()
        const query = input.query.toLowerCase()
        const items = [...document.accounts]
          .reverse()
          .map((entry) => this.view(entry))
          .filter(
            (entry) =>
              (!input.status || entry.status === input.status) &&
              (!query || `${entry.email}\n${entry.note}`.toLowerCase().includes(query)),
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        const page = Math.min(
          input.page,
          Math.max(1, Math.ceil(items.length / input.pageSize)),
        )
        return {
          items: items.slice((page - 1) * input.pageSize, page * input.pageSize),
          total: items.length,
          page,
          pageSize: input.pageSize,
          storageDurable: this.store.durable,
        }
      }
      case 'email.accounts.get': {
        const { id } = parseInput(IdInputSchema, context.payload)
        const document = await this.store.read()
        context.assertAlive()
        return this.view(findMailbox(document, id))
      }
      case 'email.accounts.targets': {
        const input = parseInput(TargetsInputSchema, context.payload)
        const document = await this.store.read()
        context.assertAlive()
        const query = input.query.toLowerCase()
        const targets = [...document.accounts]
          .reverse()
          .filter((entry) => !query || entry.email.toLowerCase().includes(query))
          .map((entry) => {
            const view = this.view(entry)
            return {
              id: view.id,
              email: view.email,
              enabled: view.enabled,
              status: view.status,
            }
          })
        const page = Math.min(
          input.page,
          Math.max(1, Math.ceil(targets.length / input.pageSize)),
        )
        return {
          items: targets.slice((page - 1) * input.pageSize, page * input.pageSize),
          total: targets.length,
          page,
          pageSize: input.pageSize,
          storageDurable: this.store.durable,
        }
      }
      case 'email.accounts.save':
        return this.save(parseInput(SaveInputSchema, context.payload), context)
      case 'email.accounts.import':
        return this.import(context)
      case 'email.accounts.remove': {
        const { id } = parseInput(IdInputSchema, context.payload)
        await this.store.mutate((document) => {
          context.assertAlive()
          findMailbox(document, id)
          document.accounts = document.accounts.filter((account) => account.id !== id)
        })
        this.refresh.invalidate(id, true)
        this.invalidateMailbox(id)
        return { removed: true }
      }
      case 'email.refresh.queue': {
        const { ids } = parseInput(RefreshInputSchema, context.payload)
        let queued = 0
        await this.store.mutate((document) => {
          context.assertAlive()
          for (const id of new Set(ids)) {
            const account = findMailbox(document, id)
            if (
              !account.enabled ||
              account.status === 'reauth-required' ||
              account.refreshRequested ||
              this.refresh.view(account).refreshing
            )
              continue
            account.refreshRequested = true
            account.nextRefreshAt = this.now().toISOString()
            queued += 1
          }
        })
        return { queued, skipped: ids.length - queued }
      }
      case 'email.receive.queue': {
        const { ids } = parseInput(ReceiveInputSchema, context.payload)
        let queued = 0
        await this.store.mutate((document) => {
          context.assertAlive()
          for (const id of ids) {
            const account = findMailbox(document, id)
            if (
              !account.enabled ||
              account.status === 'reauth-required' ||
              requiresAuthorization(account.reception.lastErrorCode) ||
              account.receiveRequested ||
              this.reception.receiving(account)
            )
              continue
            account.receiveRequested = true
            account.reception.nextCheckAt = this.now().toISOString()
            queued += 1
          }
        })
        return { queued, skipped: ids.length - queued }
      }
      case 'email.settings.get':
        parseInput(EmptyInputSchema, context.payload)
        return (await this.store.read()).settings
      case 'email.settings.save': {
        const settings = parseInput(SettingsSchema, context.payload)
        await this.saveSettings(settings, context.assertAlive)
        return settings
      }
      case 'email.messages.list':
      case 'email.messages.get':
        return this.readMail(context)
      case 'email.messages.read':
        return this.writeMail(context)
      default:
        throw invalidRequest('邮箱插件不支持此方法')
    }
  }

  private view(record: MailboxRecord): MailboxView {
    return { ...this.refresh.view(record), receiving: this.reception.receiving(record) }
  }

  private invalidateMailbox(id: string): void {
    this.mailboxScopes.get(id)?.abort(cancelled())
    this.mailboxScopes.delete(id)
    this.reception.invalidate(id)
  }

  private newAccount(input: SaveInput): MailboxRecord {
    if (!input.refreshToken) throw invalidRequest('新增邮箱需要填写 refresh_token')
    const now = this.now().toISOString()
    return {
      id: randomUUID(),
      provider: input.provider,
      transport: input.transport,
      email: input.email,
      password: input.password ?? '',
      clientId: input.clientId,
      refreshToken: input.refreshToken,
      accessToken: null,
      accessExpiresAt: null,
      credentialRevision: randomUUID(),
      note: input.note,
      enabled: input.enabled,
      status: input.enabled ? 'pending' : 'paused',
      lastAttemptAt: null,
      lastRefreshedAt: null,
      lastRotatedAt: null,
      nextRefreshAt: input.enabled ? now : null,
      refreshRequested: false,
      consecutiveFailures: 0,
      lastError: null,
      lastErrorCode: null,
      reception: {
        ...emptyReception(),
        nextCheckAt: input.enabled ? now : null,
      },
      receiveRequested: false,
      receiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    }
  }

  private async save(input: SaveInput, context: DispatchContext): Promise<unknown> {
    this.providers.get(input.provider, input.transport)
    let invalidate = false
    let changed = false
    const saved = await this.store.mutate((document) => {
      context.assertAlive()
      const duplicate = document.accounts.find(
        (entry) =>
          entry.email.toLowerCase() === input.email.toLowerCase() &&
          entry.id !== input.id,
      )
      if (duplicate) throw invalidRequest('此邮箱已经存在')
      if (!input.id) {
        if (document.accounts.length >= MAX_MAILBOXES)
          throw invalidRequest('邮箱数量已达 2000 个上限')
        const account = this.newAccount(input)
        document.accounts.push(account)
        return account
      }
      const account = findMailbox(document, input.id)
      changed =
        account.provider !== input.provider ||
        account.transport !== input.transport ||
        account.email !== input.email ||
        account.clientId !== input.clientId ||
        (input.refreshToken !== undefined && account.refreshToken !== input.refreshToken)
      invalidate = changed || account.enabled !== input.enabled
      if (changed) {
        account.credentialRevision = randomUUID()
        account.accessToken = null
        account.accessExpiresAt = null
        account.consecutiveFailures = 0
        account.lastAttemptAt = null
        account.lastRefreshedAt = null
        account.lastRotatedAt = null
        account.lastError = null
        account.lastErrorCode = null
        account.status = 'pending'
        account.nextRefreshAt = this.now().toISOString()
        account.refreshRequested = false
        account.reception = { ...emptyReception(), nextCheckAt: this.now().toISOString() }
        account.receiveRequested = false
        account.receiveFailures = 0
      }
      account.provider = input.provider
      account.transport = input.transport
      account.email = input.email
      account.clientId = input.clientId
      if (input.password !== undefined) account.password = input.password
      if (input.refreshToken !== undefined) account.refreshToken = input.refreshToken
      account.note = input.note
      if (!input.enabled) {
        account.status = 'paused'
        account.nextRefreshAt = null
        account.refreshRequested = false
        account.receiveRequested = false
      } else if (!account.enabled && !changed) {
        const authorizationRequired = requiresAuthorization(account.lastErrorCode)
        account.status = authorizationRequired
          ? 'reauth-required'
          : account.lastError
            ? 'error'
            : 'pending'
        account.nextRefreshAt = authorizationRequired ? null : this.now().toISOString()
        if (
          !requiresAuthorization(account.reception.lastErrorCode) &&
          (account.reception.nextCheckAt === null ||
            Date.parse(account.reception.nextCheckAt) <= this.now().getTime())
        )
          account.reception.nextCheckAt = this.now().toISOString()
      }
      account.enabled = input.enabled
      account.updatedAt = this.now().toISOString()
      return account
    })
    if (invalidate) {
      this.refresh.invalidate(saved.id, changed)
      this.invalidateMailbox(saved.id)
    }
    return this.view(saved)
  }

  private async import(context: DispatchContext): Promise<ImportReport> {
    const input = parseInput(ImportInputSchema, context.payload)
    this.providers.get('microsoft', input.transport)
    const parsed = parseMailboxImport(input.text)
    const report: ImportReport = {
      total: parsed.total,
      inserted: 0,
      skipped: parsed.total - parsed.rows.length,
      errors: [...parsed.errors],
    }
    await this.store.mutate((document) => {
      context.assertAlive()
      const existing = new Set(
        document.accounts.map((account) => account.email.toLowerCase()),
      )
      for (const row of parsed.rows) {
        const key = row.email.toLowerCase()
        if (existing.has(key) || document.accounts.length >= MAX_MAILBOXES) {
          report.skipped += 1
          if (report.errors.length < MAX_IMPORT_ERRORS)
            report.errors.push({
              row: row.row,
              message: existing.has(key)
                ? '邮箱已存在，已保留现有凭据'
                : '邮箱数量已达上限',
            })
          continue
        }
        const account = this.newAccount({
          ...row,
          provider: 'microsoft',
          transport: input.transport,
          note: '',
          enabled: true,
        })
        document.accounts.push(account)
        existing.add(key)
        report.inserted += 1
      }
    })
    return report
  }

  private async saveSettings(
    settings: EmailSettings,
    assertAlive: () => void,
  ): Promise<void> {
    await this.store.mutate((document) => {
      assertAlive()
      const previous = document.settings
      document.settings = settings
      for (const account of document.accounts) {
        if (
          previous.autoReceive !== settings.autoReceive ||
          previous.receiveIntervalMinutes !== settings.receiveIntervalMinutes
        ) {
          if (
            account.enabled &&
            !account.receiveRequested &&
            !requiresAuthorization(account.reception.lastErrorCode) &&
            account.receiveFailures === 0
          ) {
            account.reception.nextCheckAt = settings.autoReceive
              ? account.reception.lastCheckedAt
                ? new Date(
                    Date.parse(account.reception.lastCheckedAt) +
                      settings.receiveIntervalMinutes * 60_000,
                  ).toISOString()
                : this.now().toISOString()
              : null
          }
        }
        if (
          previous.autoRefresh === settings.autoRefresh &&
          previous.intervalMinutes === settings.intervalMinutes
        )
          continue
        if (
          !account.enabled ||
          account.status === 'reauth-required' ||
          account.refreshRequested
        )
          continue
        if (
          account.lastRefreshedAt &&
          account.accessExpiresAt &&
          account.status === 'active'
        )
          account.nextRefreshAt = nextRefresh(
            settings,
            account.lastRefreshedAt,
            account.accessExpiresAt,
          )
      }
    })
  }

  private async mailAccess(
    context: DispatchContext,
    input: { accountId: string; expectedEmail?: string | undefined },
  ) {
    const document = await this.store.read()
    context.assertAlive()
    const record = findMailbox(document, input.accountId)
    const matchesEmail = (current: MailboxRecord) =>
      input.expectedEmail === undefined ||
      current.email.trim().toLowerCase() === input.expectedEmail.trim().toLowerCase()
    if (!matchesEmail(record)) throw cancelled('关联的邮箱地址已变更，请重新关联')
    if (!record.enabled) throw invalidRequest('请先启用此邮箱')
    let scope = this.mailboxScopes.get(record.id)
    if (!scope) {
      scope = new AbortController()
      this.mailboxScopes.set(record.id, scope)
    }
    const signal = AbortSignal.any([
      this.refresh.signal,
      scope.signal,
      ...(context.signal ? [context.signal] : []),
      AbortSignal.timeout(
        Math.max(1, Math.min(120_000, context.deadlineAt - Date.now())),
      ),
    ])
    const assertCurrent = (latest: StoreDocument) => {
      context.assertAlive()
      if (signal.aborted) throw cancelled()
      const current = latest.accounts.find((entry) => entry.id === record.id)
      if (
        !current ||
        !current.enabled ||
        !matchesEmail(current) ||
        current.credentialRevision !== record.credentialRevision
      )
        throw cancelled('邮箱资料已变更，请重新读取')
      return current
    }
    const check = async () => assertCurrent(await this.store.read())
    assertCurrent(document)
    let access: Awaited<ReturnType<RefreshCoordinator['session']>>
    try {
      access = await withSignal(this.refresh.session(record.id, signal), signal)
    } catch (error) {
      await check()
      throw safeMailFailure(error)
    }
    await check()
    return {
      record,
      signal,
      session: access.session,
      check,
      assertCurrent,
      client: this.providers.get(record.provider, record.transport).mailbox,
    }
  }

  private async readMail(context: DispatchContext): Promise<unknown> {
    const list = context.method === 'email.messages.list'
    const input = list
      ? parseInput(MessageListInputSchema, context.payload)
      : parseInput(MessageGetInputSchema, context.payload)
    const access = await this.mailAccess(context, input)
    const { record, session, signal, client } = access
    const read = async (currentSession: typeof session) =>
      'messageId' in input
        ? client.get(
            currentSession,
            { folder: input.folder, messageId: input.messageId },
            signal,
          )
        : client.list(
            currentSession,
            {
              folder: input.folder,
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              ...(input.readState === undefined ? {} : { readState: input.readState }),
            },
            signal,
          )
    let result: unknown
    try {
      result = await withSignal(read(session), signal)
    } catch (error) {
      await access.check()
      if (!isPluginFailure(error) || error.code !== 'AUTH_FAILED')
        throw safeMailFailure(error)
      const retry = await withSignal(
        this.refresh.session(input.accountId, signal, session.accessToken),
        signal,
      )
      await access.check()
      if (retry.record.credentialRevision !== record.credentialRevision)
        throw cancelled('邮箱资料已变更，请重新读取')
      result = await withSignal(read(retry.session), signal)
    }
    await access.check()
    return result
  }

  private async writeMail(context: DispatchContext): Promise<unknown> {
    const input = parseInput(MessageReadInputSchema, context.payload)
    let access: Awaited<ReturnType<EmailService['mailAccess']>>
    try {
      access = await this.mailAccess(context, input)
    } catch (error) {
      context.assertAlive()
      const failure = safeMailFailure(error)
      if (failure.code === 'CANCELLED' || failure.code === 'INVALID_REQUEST')
        throw failure
      return {
        updatedIds: [],
        failures: input.messageIds.map((messageId) => ({
          messageId,
          code: failure.code,
        })),
        isRead: input.isRead,
      }
    }
    const updatedIds: string[] = []
    const failures: {
      messageId: string
      code: ReturnType<typeof safeMailFailure>['code']
    }[] = []
    for (const messageId of input.messageIds) {
      await access.check()
      try {
        await withSignal(
          access.client.setRead(
            access.session,
            {
              folder: input.folder,
              messageId,
              isRead: input.isRead,
            },
            access.signal,
          ),
          access.signal,
        )
        await access.check()
        updatedIds.push(messageId)
      } catch (error) {
        await access.check()
        failures.push({ messageId, code: safeMailFailure(error).code })
      }
    }
    if (updatedIds.length) {
      this.reception.invalidate(input.accountId)
      try {
        const page = await withSignal(
          access.client.list(
            access.session,
            { folder: input.folder, readState: 'all' },
            access.signal,
          ),
          access.signal,
        )
        await access.check()
        const counts = FolderCountsSchema.safeParse({
          total: page.total,
          unread: page.unread,
        })
        if (counts.success)
          await this.store.mutate((document) => {
            const current = access.assertCurrent(document)
            current.reception[input.folder] = counts.data
          })
      } catch {
        // The write receipt describes confirmed provider writes; failed recounts keep old counts.
        await access.check()
      }
    }
    await access.check()
    return { updatedIds, failures, isRead: input.isRead }
  }
}
