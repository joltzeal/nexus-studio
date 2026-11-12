import {
  cancelled,
  isPluginFailure,
  protocolError,
  requiresAuthorization,
} from '../domain/errors.js'
import { FolderCountsSchema } from '../domain/schemas.js'
import type {
  MailboxRecord,
  MailFolder,
  MailMessagePage,
  MailSession,
} from '../domain/types.js'
import type { Logger } from '../rpc/redact.js'
import type { EmailStore, StoreDocument } from '../store/private-store.js'
import { safeMailFailure, withSignal } from './operations.js'
import type { ProviderRegistry, RefreshCoordinator } from './refresh.js'

interface ReceptionRun {
  revision: string
  controller: AbortController
  job: Promise<void>
}

const TICK_MS = 15_000
const CONCURRENCY = 2

export class ReceptionCoordinator {
  private readonly active = new Map<string, ReceptionRun>()
  private readonly retryAt = new Map<string, number>()
  private readonly shutdown = new AbortController()
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private ticking = false

  constructor(
    private readonly store: EmailStore,
    private readonly providers: ProviderRegistry,
    private readonly refresh: RefreshCoordinator,
    private readonly logger: Logger,
    private readonly now: () => Date,
  ) {}

  start(): void {
    if (this.stopped || this.timer !== null) return
    const poll = () => {
      void this.tick().catch(() => this.logger.warn('邮箱收信调度失败，请检查插件存储'))
    }
    this.timer = setInterval(poll, TICK_MS)
    this.timer.unref()
    poll()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.shutdown.abort(cancelled())
    for (const run of this.active.values()) run.controller.abort(cancelled())
    await Promise.allSettled([...this.active.values()].map((run) => run.job))
  }

  invalidate(id: string): void {
    this.active.get(id)?.controller.abort(cancelled())
    this.retryAt.delete(id)
  }

  receiving(account: MailboxRecord): boolean {
    const run = this.active.get(account.id)
    return run?.revision === account.credentialRevision && !run.controller.signal.aborted
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      const document = await this.store.read()
      if (this.stopped) return
      const now = this.now().getTime()
      const due = document.accounts
        .filter(
          (account) =>
            account.enabled &&
            account.status !== 'reauth-required' &&
            !requiresAuthorization(account.reception.lastErrorCode) &&
            (document.settings.autoReceive || account.receiveRequested) &&
            (this.retryAt.get(account.id) ?? 0) <= now &&
            (account.reception.nextCheckAt === null ||
              Date.parse(account.reception.nextCheckAt) <= now),
        )
        .sort(
          (a, b) =>
            Date.parse(a.reception.nextCheckAt ?? a.createdAt) -
            Date.parse(b.reception.nextCheckAt ?? b.createdAt),
        )
      const jobs: Promise<void>[] = []
      for (const account of due) {
        if (this.active.size >= CONCURRENCY) break
        if (this.active.has(account.id)) continue
        const run: ReceptionRun = {
          revision: account.credentialRevision,
          controller: new AbortController(),
          job: Promise.resolve(),
        }
        this.active.set(account.id, run)
        run.job = this.execute(account, run).finally(() => {
          if (this.active.get(account.id) === run) this.active.delete(account.id)
        })
        jobs.push(run.job)
      }
      await Promise.all(jobs)
    } finally {
      this.ticking = false
    }
  }

  private current(
    document: StoreDocument,
    account: MailboxRecord,
    run: ReceptionRun,
    signal: AbortSignal,
  ): MailboxRecord {
    if (this.stopped || run.controller.signal.aborted) throw cancelled()
    if (signal.aborted) {
      if (signal.reason instanceof Error && signal.reason.name === 'TimeoutError')
        throw safeMailFailure(signal.reason)
      throw cancelled()
    }
    const current = document.accounts.find((entry) => entry.id === account.id)
    if (!current || !current.enabled || current.credentialRevision !== run.revision)
      throw cancelled()
    return current
  }

  private async execute(account: MailboxRecord, run: ReceptionRun): Promise<void> {
    const signal = AbortSignal.any([
      run.controller.signal,
      this.shutdown.signal,
      AbortSignal.timeout(120_000),
    ])
    try {
      await this.store.mutate((document) => {
        const current = this.current(document, account, run, signal)
        // Keep manual intent until completion; a crashed process resumes after the lease.
        current.reception.nextCheckAt = new Date(
          this.now().getTime() + 120_000,
        ).toISOString()
      })
      let access = await withSignal(this.refresh.session(account.id, signal), signal)
      this.current(await this.store.read(), account, run, signal)
      const client = this.providers.get(account.provider, account.transport).mailbox
      const list = async (folder: MailFolder): Promise<MailMessagePage> => {
        const read = (session: MailSession) =>
          withSignal(client.list(session, { folder, readState: 'all' }, signal), signal)
        let page: MailMessagePage
        try {
          page = await read(access.session)
        } catch (error) {
          this.current(await this.store.read(), account, run, signal)
          if (!isPluginFailure(error) || error.code !== 'AUTH_FAILED') throw error
          access = await withSignal(
            this.refresh.session(account.id, signal, access.session.accessToken),
            signal,
          )
          this.current(await this.store.read(), account, run, signal)
          page = await read(access.session)
        }
        this.current(await this.store.read(), account, run, signal)
        if (
          !FolderCountsSchema.safeParse({ total: page.total, unread: page.unread })
            .success
        )
          throw protocolError('邮箱服务返回的目录计数无效')
        return page
      }
      const inbox = await list('inbox')
      const junk = await list('junkemail')
      await this.store.mutate((document) => {
        const current = this.current(document, account, run, signal)
        const completed = this.now()
        const latest = [
          current.reception.latestReceivedAt,
          ...inbox.items.map((item) => item.receivedAt),
          ...junk.items.map((item) => item.receivedAt),
        ].filter((value): value is string => value !== null)
        current.reception = {
          inbox: { total: inbox.total, unread: inbox.unread },
          junkemail: { total: junk.total, unread: junk.unread },
          lastCheckedAt: completed.toISOString(),
          nextCheckAt: document.settings.autoReceive
            ? new Date(
                completed.getTime() + document.settings.receiveIntervalMinutes * 60_000,
              ).toISOString()
            : null,
          latestReceivedAt:
            latest.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
          lastError: null,
          lastErrorCode: null,
        }
        current.receiveRequested = false
        current.receiveFailures = 0
      })
      this.retryAt.delete(account.id)
    } catch (error) {
      if (this.stopped || run.controller.signal.aborted) return
      const failure = safeMailFailure(error)
      this.retryAt.set(account.id, this.now().getTime() + 60_000)
      try {
        await this.store.mutate((document) => {
          const current = this.current(document, account, run, run.controller.signal)
          current.receiveFailures = Math.min(32, current.receiveFailures + 1)
          const terminal = requiresAuthorization(failure.code)
          const backoff =
            Math.min(60, 2 ** Math.min(current.receiveFailures - 1, 6)) * 60_000
          current.reception.lastErrorCode = failure.code
          current.reception.lastError = failure.message
          current.reception.nextCheckAt = terminal
            ? null
            : new Date(
                this.now().getTime() + Math.max(backoff, failure.retryAfterMs ?? 0),
              ).toISOString()
          if (terminal) current.receiveRequested = false
        })
      } catch {
        this.logger.warn('邮箱收信结果未能保存，请检查插件存储')
      }
    }
  }
}
