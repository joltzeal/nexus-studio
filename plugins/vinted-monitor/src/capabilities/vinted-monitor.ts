import { randomUUID } from 'node:crypto'

import { invalidRequest, unavailable } from '../domain/errors.js'
import type { DraftItem } from '../domain/items.js'
import {
  ItemsListInputSchema,
  MonitorIdInputSchema,
  MonitorSaveInputSchema,
  RunIdInputSchema,
  RunsListInputSchema,
  UrlInspectInputSchema,
  parseOrThrow,
} from '../domain/schemas.js'
import type {
  CollectionCounts,
  ItemRecord,
  MonitorRecord,
  RunRecord,
  RunStatus,
} from '../domain/types.js'
import { normalizeMonitorUrl } from '../domain/urls.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import { collect, describeFailure } from '../services/collector.js'
import { VintedClient } from '../services/vinted.js'
import type { PrivateStore } from '../store/private-store.js'

export const VINTED_METHODS = [
  'vinted.monitors.list',
  'vinted.monitors.save',
  'vinted.monitors.remove',
  'vinted.monitors.run',
  'vinted.runs.list',
  'vinted.runs.get',
  'vinted.items.list',
  'vinted.url.inspect',
] as const

/** Local caps: one JSON document holds everything, so growth must be bounded. */
export const MAX_MONITORS = 40
export const MAX_RUNS = 200
export const MAX_ITEMS = 4000

export interface VintedMonitorOptions {
  store: PrivateStore
  logger: Logger
  client?: VintedClient
  now?: () => Date
  idFactory?: () => string
  pause?: (milliseconds: number) => Promise<void>
}

function emptyCounts(): CollectionCounts {
  return {
    discovered: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    truncated: false,
    pages: 0,
  }
}

function itemKey(monitorId: string, itemId: string): string {
  return `${monitorId}\u0000${itemId}`
}

/**
 * `monitor.collector` capability: saved Vinted searches plus a wardrobe monitor,
 * a run record per collection and a deduplicated item table.
 *
 * Collection is started, not awaited. A 20-page walk can outlast the host's
 * 120 s call deadline, so the call returns the `running` record and the page
 * polls `vinted.runs.get` — the record, not the call, is the source of truth.
 */
export class VintedMonitor {
  readonly id = 'monitor.collector'
  readonly name = 'Vinted 商品监控'

  private readonly store: PrivateStore
  private readonly logger: Logger
  private readonly client: VintedClient
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly pause: ((milliseconds: number) => Promise<void>) | undefined
  private readonly active = new Set<string>()
  private reconciled: Promise<void> | null = null
  private ticking = false

  constructor(options: VintedMonitorOptions) {
    this.store = options.store
    this.logger = options.logger
    this.client = options.client ?? new VintedClient()
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? randomUUID
    this.pause = options.pause
  }

  status(): Record<string, unknown> {
    return {
      storage: this.store.kind,
      storageDurable: this.store.durable,
      activeRuns: this.active.size,
    }
  }

  async call(context: DispatchContext): Promise<unknown> {
    await this.ensureReconciled()
    context.assertAlive()
    switch (context.method) {
      case 'vinted.monitors.list':
        return await this.listMonitors(context)
      case 'vinted.monitors.save':
        return await this.saveMonitor(context)
      case 'vinted.monitors.remove':
        return await this.removeMonitor(context)
      case 'vinted.monitors.run':
        return await this.runMonitor(context)
      case 'vinted.runs.list':
        return await this.listRuns(context)
      case 'vinted.runs.get':
        return await this.getRun(context)
      case 'vinted.items.list':
        return await this.listItems(context)
      case 'vinted.url.inspect':
        return await this.inspectUrl(context)
      default:
        throw invalidRequest('插件不支持该方法')
    }
  }

  /**
   * Scheduler entry point, called on an interval by the process entry.
   *
   * Runs are sequential: a monitor whose interval has elapsed is collected
   * before the next one starts, so a tick never opens several connections to
   * the same host at once.
   */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.ensureReconciled()
      const document = await this.store.read()
      const now = this.now().getTime()
      for (const monitor of document.monitors) {
        if (!monitor.enabled) continue
        if (this.active.has(monitor.id)) continue
        if (!this.due(monitor, now)) continue
        try {
          await this.startRun(monitor)
        } catch (error) {
          this.logger.warn('定时采集启动失败', {
            monitorId: monitor.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally {
      this.ticking = false
    }
  }

  private due(monitor: MonitorRecord, now: number): boolean {
    if (monitor.lastRunAt === null) return true
    const last = Date.parse(monitor.lastRunAt)
    if (Number.isNaN(last)) return true
    return now - last >= monitor.intervalMinutes * 60_000
  }

  /** A run left `running` by a previous process can never finish. */
  private async ensureReconciled(): Promise<void> {
    if (this.reconciled === null) {
      this.reconciled = this.reconcile()
    }
    await this.reconciled
  }

  private async reconcile(): Promise<void> {
    const document = await this.store.read()
    const stale = document.runs.filter((run) => run.status === 'running')
    if (stale.length === 0) return
    const finishedAt = this.now().toISOString()
    await this.store.mutate((draft) => {
      for (const run of draft.runs) {
        if (run.status !== 'running') continue
        run.status = 'interrupted'
        run.finishedAt = finishedAt
        run.error = '插件进程已重启，本次采集被中断'
      }
      for (const monitor of draft.monitors) {
        if (monitor.lastStatus === 'running') monitor.lastStatus = 'interrupted'
      }
    })
    this.logger.warn('已将中断的采集记录标记为 interrupted', { count: stale.length })
  }

  private async listMonitors(context: DispatchContext): Promise<unknown> {
    const document = await this.store.read()
    context.assertAlive()
    const counts = new Map<string, number>()
    for (const item of document.items) {
      counts.set(item.monitorId, (counts.get(item.monitorId) ?? 0) + 1)
    }
    return {
      items: document.monitors,
      total: document.monitors.length,
      itemCounts: Object.fromEntries(counts),
      storageDurable: this.store.durable,
    }
  }

  private async saveMonitor(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(MonitorSaveInputSchema, context.payload)
    // Validated before the write so an unusable URL never reaches storage.
    const target = normalizeMonitorUrl(input.searchUrl)
    const now = this.now().toISOString()

    const result = await this.store.mutate((document) => {
      if (input.id === undefined) {
        if (document.monitors.length >= MAX_MONITORS) {
          throw invalidRequest(`监控上限为 ${MAX_MONITORS} 个，请先删除部分监控`)
        }
        const created: MonitorRecord = {
          id: this.idFactory(),
          name: input.name,
          searchUrl: target.url,
          kind: target.kind,
          host: target.host,
          userId: target.userId,
          intervalMinutes: input.intervalMinutes,
          maxPages: input.maxPages,
          perPage: input.perPage,
          enabled: input.enabled,
          createdAt: now,
          updatedAt: now,
          lastRunAt: null,
          lastStatus: null,
        }
        document.monitors.unshift(created)
        return { item: created, created: true }
      }
      const existing = document.monitors.find((entry) => entry.id === input.id)
      if (existing === undefined) throw invalidRequest('监控不存在或已被删除')
      existing.name = input.name
      existing.searchUrl = target.url
      existing.kind = target.kind
      existing.host = target.host
      existing.userId = target.userId
      existing.intervalMinutes = input.intervalMinutes
      existing.maxPages = input.maxPages
      existing.perPage = input.perPage
      existing.enabled = input.enabled
      existing.updatedAt = now
      return { item: existing, created: false }
    })
    context.assertAlive()
    return result
  }

  private async removeMonitor(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(MonitorIdInputSchema, context.payload)
    if (this.active.has(input.monitorId)) {
      throw invalidRequest('该监控正在采集中，请等本次采集结束后再删除')
    }
    const removed = await this.store.mutate((document) => {
      const before = document.monitors.length
      document.monitors = document.monitors.filter(
        (entry) => entry.id !== input.monitorId,
      )
      document.runs = document.runs.filter((run) => run.monitorId !== input.monitorId)
      document.items = document.items.filter((item) => item.monitorId !== input.monitorId)
      return before !== document.monitors.length
    })
    context.assertAlive()
    return { monitorId: input.monitorId, removed }
  }

  private async runMonitor(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(MonitorIdInputSchema, context.payload)
    const document = await this.store.read()
    const monitor = document.monitors.find((entry) => entry.id === input.monitorId)
    if (monitor === undefined) throw invalidRequest('监控不存在或已被删除')
    if (this.active.has(monitor.id)) {
      throw invalidRequest('该监控正在采集中，请稍后查看记录')
    }
    const run = await this.startRun(monitor)
    context.assertAlive()
    return { run }
  }

  /** Creates the run record, kicks off the walk and returns immediately. */
  private async startRun(monitor: MonitorRecord): Promise<RunRecord> {
    const startedAt = this.now().toISOString()
    const run: RunRecord = {
      id: this.idFactory(),
      monitorId: monitor.id,
      monitorName: monitor.name,
      status: 'running',
      startedAt,
      finishedAt: null,
      discovered: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      truncated: false,
      pages: 0,
      error: null,
    }
    await this.store.mutate((document) => {
      document.runs.unshift(run)
      if (document.runs.length > MAX_RUNS) document.runs.length = MAX_RUNS
      const target = document.monitors.find((entry) => entry.id === monitor.id)
      if (target !== undefined) {
        // Written before the walk starts so the scheduler cannot re-trigger it.
        target.lastRunAt = startedAt
        target.lastStatus = 'running'
      }
    })
    this.active.add(monitor.id)
    void this.execute(monitor, run.id)
    return run
  }

  private async execute(monitor: MonitorRecord, runId: string): Promise<void> {
    const outcome = await this.walk(monitor, runId)
    await this.finishRun(runId, monitor.id, outcome.status, outcome.counts, outcome.error)
    this.active.delete(monitor.id)
  }

  /** One collection attempt, with every failure folded into a runnable result. */
  private async walk(
    monitor: MonitorRecord,
    runId: string,
  ): Promise<{ status: RunStatus; counts: CollectionCounts; error: string | null }> {
    try {
      const target = normalizeMonitorUrl(monitor.searchUrl)
      const result = await collect({
        monitor,
        target,
        client: this.client,
        hooks: {
          applyPage: (items) => this.upsertItems(monitor.id, items),
          progress: (progress) => this.patchRun(runId, progress),
        },
        ...(this.pause === undefined ? {} : { pause: this.pause }),
      })
      return result
    } catch (cause) {
      this.logger.warn('采集失败', {
        monitorId: monitor.id,
        error: cause instanceof Error ? cause.message : String(cause),
      })
      return {
        status: 'failed',
        counts: emptyCounts(),
        error: describeFailure(cause),
      }
    }
  }

  private async upsertItems(
    monitorId: string,
    drafts: DraftItem[],
  ): Promise<{ inserted: number; updated: number }> {
    const now = this.now().toISOString()
    return await this.store.mutate((document) => {
      const positions = new Map<string, number>()
      document.items.forEach((item, index) => {
        positions.set(itemKey(item.monitorId, item.id), index)
      })
      const added: ItemRecord[] = []
      let inserted = 0
      let updated = 0
      for (const draft of drafts) {
        const at = positions.get(itemKey(monitorId, draft.id))
        if (at === undefined) {
          added.push({ ...draft, monitorId, firstSeenAt: now, lastSeenAt: now })
          inserted += 1
          continue
        }
        const existing = document.items[at]
        if (existing === undefined) continue
        // `firstSeenAt` is the point of the whole table: it never moves.
        document.items[at] = {
          ...existing,
          ...draft,
          monitorId,
          firstSeenAt: existing.firstSeenAt,
          lastSeenAt: now,
        }
        updated += 1
      }
      if (added.length > 0) {
        document.items = [...added, ...document.items]
      }
      if (document.items.length > MAX_ITEMS) {
        document.items = document.items.slice(0, MAX_ITEMS)
      }
      return { inserted, updated }
    })
  }

  private async patchRun(runId: string, counts: CollectionCounts): Promise<void> {
    await this.store.mutate((document) => {
      const run = document.runs.find((entry) => entry.id === runId)
      if (run === undefined || run.status !== 'running') return
      run.discovered = counts.discovered
      run.inserted = counts.inserted
      run.updated = counts.updated
      run.skipped = counts.skipped
      run.failed = counts.failed
      run.truncated = counts.truncated
      run.pages = counts.pages
    })
  }

  private async finishRun(
    runId: string,
    monitorId: string,
    status: RunStatus,
    counts: CollectionCounts,
    error: string | null,
  ): Promise<void> {
    const finishedAt = this.now().toISOString()
    try {
      await this.store.mutate((document) => {
        const run = document.runs.find((entry) => entry.id === runId)
        if (run !== undefined) {
          run.status = status
          run.finishedAt = finishedAt
          run.discovered = counts.discovered
          run.inserted = counts.inserted
          run.updated = counts.updated
          run.skipped = counts.skipped
          run.failed = counts.failed
          run.truncated = counts.truncated
          run.pages = counts.pages
          run.error = error
        }
        const monitor = document.monitors.find((entry) => entry.id === monitorId)
        if (monitor !== undefined) monitor.lastStatus = status
      })
    } catch (cause) {
      // The walk already happened; failing to write the outcome must not crash
      // the plugin process, but the user still deserves the truth.
      this.logger.error('采集记录写入失败', {
        runId,
        error: cause instanceof Error ? cause.message : String(cause),
      })
      throw unavailable('采集记录写入失败', cause)
    }
    this.logger.info('采集完成', {
      runId,
      status,
      discovered: counts.discovered,
      inserted: counts.inserted,
    })
  }

  private async listRuns(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(RunsListInputSchema, context.payload)
    const document = await this.store.read()
    context.assertAlive()
    const limit = input.limit ?? 20
    const items = document.runs
      .filter((run) => input.monitorId === undefined || run.monitorId === input.monitorId)
      .slice(0, limit)
    return { items, total: items.length }
  }

  private async getRun(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(RunIdInputSchema, context.payload)
    const document = await this.store.read()
    context.assertAlive()
    const run = document.runs.find((entry) => entry.id === input.runId)
    if (run === undefined) throw invalidRequest('采集记录不存在或已被清理')
    return { item: run }
  }

  private async listItems(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(ItemsListInputSchema, context.payload)
    const document = await this.store.read()
    context.assertAlive()
    const keyword = (input.keyword ?? '').toLowerCase()
    const rows = document.items
      .filter(
        (item) => input.monitorId === undefined || item.monitorId === input.monitorId,
      )
      .filter((item) => keyword === '' || matches(item, keyword))
      .sort(byNewest)
    const start = input.page * input.pageSize
    return {
      items: rows.slice(start, start + input.pageSize),
      total: rows.length,
      page: input.page,
      pageSize: input.pageSize,
    }
  }

  private async inspectUrl(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(UrlInspectInputSchema, context.payload)
    const target = normalizeMonitorUrl(input.url)
    return {
      kind: target.kind,
      host: target.host,
      userId: target.userId,
      url: target.url,
    }
  }
}

function matches(item: ItemRecord, keyword: string): boolean {
  return (
    item.title.toLowerCase().includes(keyword) ||
    item.brand.toLowerCase().includes(keyword) ||
    item.seller.toLowerCase().includes(keyword)
  )
}

function byNewest(left: ItemRecord, right: ItemRecord): number {
  const a = left.listedAt ?? left.firstSeenAt
  const b = right.listedAt ?? right.firstSeenAt
  return b.localeCompare(a)
}
