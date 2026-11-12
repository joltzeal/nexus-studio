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
  IdInputSchema,
  ImportInputSchema,
  ListInputSchema,
  MAX_IMPORT_ERRORS,
  MAX_MAILBOXES,
  MessageGetInputSchema,
  MessageListInputSchema,
  RefreshInputSchema,
  SaveInputSchema,
  SettingsSchema,
  parseInput,
  type SaveInput,
} from '../domain/schemas.js'
import type { EmailSettings, ImportReport, MailboxRecord } from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import {
  RefreshCoordinator,
  findMailbox,
  nextRefresh,
  type ProviderRegistry,
} from '../services/refresh.js'
import type { EmailStore } from '../store/private-store.js'

export const EMAIL_METHODS = [
  'email.accounts.list',
  'email.accounts.save',
  'email.accounts.import',
  'email.accounts.remove',
  'email.refresh.queue',
  'email.settings.get',
  'email.settings.save',
  'email.messages.list',
  'email.messages.get',
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
  }

  start(): void {
    this.refresh.start()
  }
  stop(): Promise<void> {
    return this.refresh.stop()
  }
  tick(): Promise<void> {
    return this.refresh.tick()
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
          .map((entry) => this.refresh.view(entry))
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
      default:
        throw invalidRequest('邮箱插件不支持此方法')
    }
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
      } else if (!account.enabled && !changed) {
        const authorizationRequired = requiresAuthorization(account.lastErrorCode)
        account.status = authorizationRequired
          ? 'reauth-required'
          : account.lastError
            ? 'error'
            : 'pending'
        account.nextRefreshAt = authorizationRequired ? null : this.now().toISOString()
      }
      account.enabled = input.enabled
      account.updatedAt = this.now().toISOString()
      return account
    })
    if (invalidate) this.refresh.invalidate(saved.id, changed)
    return this.refresh.view(saved)
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
      document.settings = settings
      for (const account of document.accounts) {
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

  private async readMail(context: DispatchContext): Promise<unknown> {
    const list = context.method === 'email.messages.list'
    const input = list
      ? parseInput(MessageListInputSchema, context.payload)
      : parseInput(MessageGetInputSchema, context.payload)
    const signal = AbortSignal.any([
      this.refresh.signal,
      ...(context.signal ? [context.signal] : []),
      AbortSignal.timeout(
        Math.max(1, Math.min(120_000, context.deadlineAt - Date.now())),
      ),
    ])
    const { record, session } = await this.refresh.session(input.accountId, signal)
    context.assertAlive()
    const client = this.providers.get(record.provider, record.transport).mailbox
    const read = (currentSession: typeof session) =>
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
            },
            signal,
          )
    let result: unknown
    try {
      result = await read(session)
    } catch (error) {
      if (!isPluginFailure(error) || error.code !== 'AUTH_FAILED') throw error
      context.assertAlive()
      const retry = await this.refresh.session(
        input.accountId,
        signal,
        session.accessToken,
      )
      if (retry.record.credentialRevision !== record.credentialRevision)
        throw cancelled('邮箱资料已变更，请重新读取')
      result = await read(retry.session)
    }
    context.assertAlive()
    signal.throwIfAborted()
    const latest = findMailbox(await this.store.read(), record.id)
    if (latest.credentialRevision !== record.credentialRevision || !latest.enabled)
      throw cancelled('邮箱资料已变更，请重新读取')
    return result
  }
}
