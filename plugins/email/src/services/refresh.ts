import {
  PluginFailure,
  cancelled,
  invalidRequest,
  requiresAuthorization,
  unavailable,
} from '../domain/errors.js'
import { CredentialSchema } from '../domain/schemas.js'
import type {
  EmailProvider,
  EmailSettings,
  MailboxRecord,
  MailboxView,
  MailSession,
  MailTransport,
  TokenSet,
} from '../domain/types.js'
import type { Logger } from '../rpc/redact.js'
import type { EmailStore, StoreDocument } from '../store/private-store.js'
import { safeMailFailure } from './operations.js'

export interface ProviderRegistry {
  get(provider: string, transport: MailTransport): EmailProvider
}
interface ActiveRefresh {
  revision: string
  controller: AbortController
  job: Promise<void>
}
interface PendingWrite {
  revision: string
  tokens: TokenSet
  receivedAt: string
  retryAt: number
}

const TICK_MS = 15_000
const CONCURRENCY = 2
const WRITE_ERROR = 'Token 刷新结果未能保存，正在重试写入，请检查磁盘空间'

function nextRefresh(
  settings: EmailSettings,
  refreshedAt: string,
  expiresAt: string,
): string {
  const refreshed = Date.parse(refreshedAt)
  const expiry = Date.parse(expiresAt)
  // Very short access lifetimes still get a finite, non-spinning interval.
  const early = expiry - Math.min(5 * 60_000, Math.max(1000, (expiry - refreshed) / 5))
  return new Date(
    Math.max(
      refreshed + 1000,
      Math.min(refreshed + settings.intervalMinutes * 60_000, early),
    ),
  ).toISOString()
}

function find(document: StoreDocument, id: string): MailboxRecord {
  const record = document.accounts.find((entry) => entry.id === id)
  if (!record) throw invalidRequest('邮箱不存在或已删除')
  return record
}

export class RefreshCoordinator {
  private readonly active = new Map<string, ActiveRefresh>()
  private readonly pending = new Map<string, PendingWrite>()
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private ticking = false
  private readonly shutdown = new AbortController()

  constructor(
    private readonly store: EmailStore,
    private readonly providers: ProviderRegistry,
    private readonly logger: Logger,
    private readonly now: () => Date,
  ) {}

  get signal(): AbortSignal {
    return this.shutdown.signal
  }

  start(): void {
    if (this.stopped || this.timer !== null) return
    const poll = () => {
      void this.tick().catch(() => this.logger.warn('邮箱刷新调度失败，请检查插件存储'))
    }
    this.timer = setInterval(poll, TICK_MS)
    this.timer.unref()
    poll()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.shutdown.abort(cancelled('邮箱插件已停止'))
    for (const run of this.active.values()) run.controller.abort(cancelled())
    await Promise.allSettled([...this.active.values()].map((run) => run.job))
  }

  invalidate(id: string, changedCredentials: boolean): void {
    this.active.get(id)?.controller.abort(cancelled('邮箱资料已变更'))
    if (changedCredentials) this.pending.delete(id)
  }

  view(record: MailboxRecord): MailboxView {
    const waiting = this.pending.get(record.id)?.revision === record.credentialRevision
    return {
      id: record.id,
      provider: record.provider,
      transport: record.transport,
      email: record.email,
      clientId: record.clientId,
      note: record.note,
      enabled: record.enabled,
      status: waiting && record.enabled ? 'error' : record.status,
      hasPassword: record.password.length > 0,
      hasRefreshToken: record.refreshToken.length > 0,
      refreshing: this.active.get(record.id)?.revision === record.credentialRevision,
      receiving: false,
      reception: record.reception,
      accessExpiresAt: record.accessExpiresAt,
      lastAttemptAt: record.lastAttemptAt,
      lastRefreshedAt: record.lastRefreshedAt,
      lastRotatedAt: record.lastRotatedAt,
      nextRefreshAt: record.nextRefreshAt,
      lastError: waiting ? WRITE_ERROR : record.lastError,
      lastErrorCode: waiting ? 'UNAVAILABLE' : record.lastErrorCode,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      const document = await this.store.read()
      if (this.stopped) return
      const now = this.now().getTime()
      const due = document.accounts
        .filter((account) => {
          const pending = this.pending.get(account.id)
          if (pending?.revision === account.credentialRevision)
            return pending.retryAt <= now
          return (
            account.enabled &&
            account.status !== 'reauth-required' &&
            (document.settings.autoRefresh || account.refreshRequested) &&
            (account.nextRefreshAt === null || Date.parse(account.nextRefreshAt) <= now)
          )
        })
        .sort(
          (a, b) =>
            Date.parse(a.nextRefreshAt ?? a.createdAt) -
            Date.parse(b.nextRefreshAt ?? b.createdAt),
        )
      const jobs: Promise<void>[] = []
      for (const account of due) {
        if (this.active.size >= CONCURRENCY) break
        const job = this.launch(account)
        if (job !== null) jobs.push(job)
      }
      await Promise.all(jobs)
    } finally {
      this.ticking = false
    }
  }

  async session(
    id: string,
    signal: AbortSignal,
    rejectedToken?: string,
  ): Promise<{ record: MailboxRecord; session: MailSession }> {
    signal.throwIfAborted()
    this.shutdown.signal.throwIfAborted()
    let record = find(await this.store.read(), id)
    if (!record.enabled) throw invalidRequest('请先启用此邮箱')
    if (record.status === 'reauth-required')
      throw new PluginFailure(
        record.lastErrorCode === 'PERMISSION_DENIED'
          ? 'PERMISSION_DENIED'
          : 'AUTH_FAILED',
        record.lastError ?? '请更新邮箱授权',
      )
    const valid = (value: MailboxRecord) =>
      value.accessToken !== null &&
      value.accessExpiresAt !== null &&
      Date.parse(value.accessExpiresAt) > this.now().getTime() + 30_000
    if (!valid(record) || this.pending.has(id) || record.accessToken === rejectedToken) {
      const active = this.active.get(id)
      const pending = this.pending.get(id)
      if (!active && pending && pending.retryAt > this.now().getTime())
        throw unavailable(WRITE_ERROR)
      if (
        !active &&
        !pending &&
        record.status === 'error' &&
        record.nextRefreshAt !== null &&
        Date.parse(record.nextRefreshAt) > this.now().getTime()
      )
        throw unavailable(record.lastError ?? '邮箱刷新正在退避，请稍后重试')
      const job = active?.job ?? this.launch(record)
      if (!job) throw unavailable('邮箱刷新任务较多，请稍后读取')
      await waitWithSignal(job, signal)
      signal.throwIfAborted()
      const latest = find(await this.store.read(), id)
      if (latest.credentialRevision !== record.credentialRevision || !latest.enabled)
        throw cancelled('邮箱资料已变更，请重新读取')
      record = latest
      if (this.pending.has(id)) throw unavailable(WRITE_ERROR)
      if (!valid(record) || record.status === 'reauth-required')
        throw new PluginFailure(
          record.status === 'reauth-required'
            ? record.lastErrorCode === 'PERMISSION_DENIED'
              ? 'PERMISSION_DENIED'
              : 'AUTH_FAILED'
            : 'UNAVAILABLE',
          record.lastError ?? '无法获取有效的邮箱访问令牌，请重试',
        )
    }
    return { record, session: { email: record.email, accessToken: record.accessToken! } }
  }

  private launch(account: MailboxRecord): Promise<void> | null {
    if (this.stopped) return null
    const existing = this.active.get(account.id)
    if (existing) return existing.job
    if (this.active.size >= CONCURRENCY) return null
    const run: ActiveRefresh = {
      revision: account.credentialRevision,
      controller: new AbortController(),
      job: Promise.resolve(),
    }
    this.active.set(account.id, run)
    run.job = this.execute(account, run).finally(() => {
      if (this.active.get(account.id) === run) this.active.delete(account.id)
    })
    return run.job
  }

  private async commitPending(id: string, result: PendingWrite): Promise<void> {
    await this.store.mutate((document) => {
      const current = document.accounts.find(
        (account) => account.id === id && account.credentialRevision === result.revision,
      )
      if (!current) return
      const expiresAt = new Date(
        Date.parse(result.receivedAt) + result.tokens.expiresIn * 1000,
      ).toISOString()
      if (
        result.tokens.refreshToken !== undefined &&
        result.tokens.refreshToken !== current.refreshToken
      ) {
        current.refreshToken = result.tokens.refreshToken
        current.lastRotatedAt = result.receivedAt
      }
      current.accessToken = result.tokens.accessToken
      current.accessExpiresAt = expiresAt
      current.lastRefreshedAt = result.receivedAt
      current.nextRefreshAt = current.enabled
        ? nextRefresh(document.settings, result.receivedAt, expiresAt)
        : null
      current.status = current.enabled ? 'active' : 'paused'
      current.consecutiveFailures = 0
      current.lastError = null
      current.lastErrorCode = null
      current.refreshRequested = false
      current.updatedAt = this.now().toISOString()
    })
    if (this.pending.get(id) === result) this.pending.delete(id)
  }

  private async execute(account: MailboxRecord, run: ActiveRefresh): Promise<void> {
    try {
      const pending = this.pending.get(account.id)
      if (pending?.revision === run.revision) {
        await this.commitPending(account.id, pending)
        return
      }
      await this.store.mutate((document) => {
        run.controller.signal.throwIfAborted()
        if (this.stopped) throw cancelled()
        const current = find(document, account.id)
        if (current.credentialRevision !== run.revision || !current.enabled)
          throw cancelled('邮箱资料已变更')
        current.lastAttemptAt = this.now().toISOString()
        current.nextRefreshAt = new Date(this.now().getTime() + 120_000).toISOString()
      })
      const tokens = await this.providers
        .get(account.provider, account.transport)
        .tokens.refresh(
          {
            email: account.email,
            clientId: account.clientId,
            refreshToken: account.refreshToken,
          },
          AbortSignal.any([
            run.controller.signal,
            this.shutdown.signal,
            AbortSignal.timeout(60_000),
          ]),
        )
      if (
        !CredentialSchema.safeParse(tokens.accessToken).success ||
        (tokens.refreshToken !== undefined &&
          !CredentialSchema.safeParse(tokens.refreshToken).success) ||
        !Number.isFinite(tokens.expiresIn) ||
        tokens.expiresIn < 1 ||
        tokens.expiresIn > 7 * 86400
      )
        throw unavailable('邮箱服务返回的令牌格式无效')
      const latest = (await this.store.read()).accounts.find(
        (entry) => entry.id === account.id && entry.credentialRevision === run.revision,
      )
      if (!latest) return
      // Keep the rotated pair available for a disk retry before any new exchange.
      const result: PendingWrite = {
        revision: run.revision,
        tokens,
        receivedAt: this.now().toISOString(),
        retryAt: this.now().getTime() + 60_000,
      }
      this.pending.set(account.id, result)
      await this.commitPending(account.id, result)
    } catch (error) {
      const pending = this.pending.get(account.id)
      if (pending?.revision === run.revision) {
        pending.retryAt = this.now().getTime() + 60_000
        this.logger.warn('邮箱刷新结果保存失败，将重试写入')
        return
      }
      if (this.stopped) return
      try {
        await this.store.mutate((document) => {
          const current = document.accounts.find(
            (entry) =>
              entry.id === account.id && entry.credentialRevision === run.revision,
          )
          if (!current || !current.enabled) return
          const failure = safeMailFailure(error)
          current.lastError = failure.message
          current.lastErrorCode = failure.code
          current.consecutiveFailures = Math.min(32, current.consecutiveFailures + 1)
          const authorizationRequired = requiresAuthorization(failure.code)
          current.status = authorizationRequired ? 'reauth-required' : 'error'
          if (authorizationRequired) current.refreshRequested = false
          const backoff =
            Math.min(60, 2 ** Math.min(current.consecutiveFailures - 1, 6)) * 60_000
          current.nextRefreshAt =
            current.status === 'reauth-required'
              ? null
              : new Date(
                  this.now().getTime() +
                    Math.max(backoff, Math.min(60 * 60_000, failure.retryAfterMs ?? 0)),
                ).toISOString()
        })
      } catch {
        this.logger.warn('邮箱刷新错误未能保存，请检查插件存储')
      }
    }
  }
}

async function waitWithSignal(job: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let listener!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(cancelled())
    signal.addEventListener('abort', listener, { once: true })
  })
  try {
    await Promise.race([job, aborted])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}

export { find as findMailbox, nextRefresh }
