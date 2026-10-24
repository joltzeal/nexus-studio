import { randomUUID } from 'node:crypto'
import { invalidRequest } from '../domain/errors.js'
import { proxyHost, proxyView, selectProxy, validateProxy } from '../domain/proxies.js'
import {
  EmptyInputSchema,
  ImageCloseInputSchema,
  ImageOpenInputSchema,
  ImageReadInputSchema,
  ItemAvailabilityInputSchema,
  ItemIdInputSchema,
  ItemStarInputSchema,
  ItemsListInputSchema,
  MonitorIdInputSchema,
  MonitorListInputSchema,
  MonitorSaveInputSchema,
  ProxyDefaultInputSchema,
  ProxyIdInputSchema,
  ProxySaveInputSchema,
  RunIdInputSchema,
  RunsListInputSchema,
  UrlInspectInputSchema,
  parseOrThrow,
} from '../domain/schemas.js'
import { sellerRecord } from '../domain/sellers.js'
import type {
  CollectionCounts,
  MonitorRecord,
  ProxyRecord,
  RunRecord,
} from '../domain/types.js'
import { normalizeMonitorUrl } from '../domain/urls.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import { collect, describeFailure, type CollectResult } from '../services/collector.js'
import { VintedImages } from '../services/images.js'
import { VintedClient } from '../services/vinted.js'
import {
  applyItems,
  itemView,
  markMissing,
  paginate,
  queryItems,
  requireItem,
  scanKey,
} from '../store/archive.js'
import type { PrivateStore, StoreDocument } from '../store/private-store.js'

export const VINTED_METHODS = [
  'vinted.monitors.list',
  'vinted.monitors.save',
  'vinted.monitors.remove',
  'vinted.monitors.run',
  'vinted.runs.list',
  'vinted.runs.get',
  'vinted.items.list',
  'vinted.items.get',
  'vinted.items.star',
  'vinted.items.availability',
  'vinted.items.remove',
  'vinted.items.monitorSeller',
  'vinted.proxies.list',
  'vinted.proxies.save',
  'vinted.proxies.remove',
  'vinted.proxies.default',
  'vinted.image.open',
  'vinted.image.read',
  'vinted.image.close',
  'vinted.url.inspect',
] as const
export const MAX_MONITORS = 40
export const MAX_RUNS = 200
/** Legacy export only: archived items are never silently evicted. */
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
    userFailed: 0,
    skipped: 0,
    failed: 0,
    truncated: false,
    pages: 0,
  }
}
function requireMonitor(document: StoreDocument, id: string): MonitorRecord {
  const monitor = document.monitors.find((m) => m.id === id)
  if (!monitor) throw invalidRequest('监控不存在或已被删除')
  return monitor
}

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
  private readonly images = new VintedImages()
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
    const payload = context.payload
    switch (context.method) {
      case 'vinted.monitors.list': {
        const input = parseOrThrow(MonitorListInputSchema, payload)
        const doc = await this.store.read()
        const itemCounts: Record<string, number> = Object.fromEntries(
          doc.monitors.map((m) => [m.id, 0]),
        )
        for (const item of doc.items) {
          if (item.deletedAt !== null) continue
          for (const id of item.monitorIds) itemCounts[id] = (itemCounts[id] ?? 0) + 1
        }
        const page =
          input.page === undefined && input.pageSize === undefined
            ? { items: doc.monitors, total: doc.monitors.length }
            : paginate(doc.monitors, input.page ?? 0, input.pageSize ?? 20)
        return { ...page, itemCounts, storageDurable: this.store.durable }
      }
      case 'vinted.monitors.save':
        return this.saveMonitor(payload)
      case 'vinted.monitors.remove':
        return this.removeMonitor(payload)
      case 'vinted.monitors.run': {
        const { monitorId } = parseOrThrow(MonitorIdInputSchema, payload)
        return { run: await this.startRun(monitorId) }
      }
      case 'vinted.runs.list': {
        const input = parseOrThrow(RunsListInputSchema, payload)
        const rows = (await this.store.read()).runs.filter(
          (r) => input.monitorId === undefined || input.monitorId === r.monitorId,
        )
        if (input.page !== undefined || input.pageSize !== undefined)
          return paginate(rows, input.page ?? 0, input.pageSize ?? 20)
        return { items: rows.slice(0, input.limit ?? 20), total: rows.length }
      }
      case 'vinted.runs.get': {
        const { runId } = parseOrThrow(RunIdInputSchema, payload)
        const item = (await this.store.read()).runs.find((r) => r.id === runId)
        if (!item) throw invalidRequest('采集记录不存在或已被清理')
        return { item }
      }
      case 'vinted.items.list':
        return queryItems(
          await this.store.read(),
          parseOrThrow(ItemsListInputSchema, payload),
        )
      case 'vinted.items.get': {
        const { itemId } = parseOrThrow(ItemIdInputSchema, payload)
        const doc = await this.store.read()
        return { item: itemView(doc, requireItem(doc, itemId)) }
      }
      case 'vinted.items.star': {
        const input = parseOrThrow(ItemStarInputSchema, payload)
        return this.store.mutate((doc) => {
          const item = requireItem(doc, input.itemId)
          item.starred = input.starred
          return { item: itemView(doc, item) }
        })
      }
      case 'vinted.items.availability': {
        const input = parseOrThrow(ItemAvailabilityInputSchema, payload)
        return this.store.mutate((doc) => {
          const item = requireItem(doc, input.itemId)
          item.availabilityStatus = input.status
          item.statusCheckedAt = this.now().toISOString()
          item.statusNote = input.note || null
          if (input.status === 'pending') item.missingSince ??= item.statusCheckedAt
          return { item: itemView(doc, item) }
        })
      }
      case 'vinted.items.remove': {
        const { itemId } = parseOrThrow(ItemIdInputSchema, payload)
        return this.store.mutate((doc) => {
          const item = doc.items.find((i) => i.id === itemId)
          if (!item || item.deletedAt !== null) return { removed: false }
          item.deletedAt = this.now().toISOString()
          return { removed: true }
        })
      }
      case 'vinted.items.monitorSeller':
        return this.monitorSeller(payload)
      case 'vinted.proxies.list': {
        parseOrThrow(EmptyInputSchema, payload)
        const doc = await this.store.read()
        return {
          items: doc.proxies.map(proxyView),
          defaultProxyId: doc.defaultProxyId,
          storageDurable: this.store.durable,
        }
      }
      case 'vinted.proxies.save':
        return this.saveProxy(payload)
      case 'vinted.proxies.remove': {
        const { proxyId } = parseOrThrow(ProxyIdInputSchema, payload)
        return this.store.mutate((doc) => {
          if (
            doc.defaultProxyId === proxyId ||
            doc.monitors.some((m) => m.proxyId === proxyId)
          ) {
            throw invalidRequest('此代理仍被监控或默认代理引用，请先修改引用')
          }
          const before = doc.proxies.length
          doc.proxies = doc.proxies.filter((p) => p.id !== proxyId)
          return { removed: before !== doc.proxies.length }
        })
      }
      case 'vinted.proxies.default': {
        const { proxyId } = parseOrThrow(ProxyDefaultInputSchema, payload)
        return this.store.mutate((doc) => {
          if (proxyId !== null) selectProxy(doc, proxyId)
          doc.defaultProxyId = proxyId
          return { defaultProxyId: proxyId }
        })
      }
      case 'vinted.image.open': {
        const input = parseOrThrow(ImageOpenInputSchema, payload)
        const doc = await this.store.read()
        const item = requireItem(doc, input.itemId)
        const source = doc.monitors.find((m) => m.id === item.monitorId)
        const proxy = selectProxy(doc, source ? source.proxyId : item.sourceProxyId)
        const scope = this.client.scope(proxy)
        try {
          return await this.images.open(
            itemView(doc, item),
            input.url,
            scope.transport.fetch,
            context,
          )
        } finally {
          await scope.transport.close()
        }
      }
      case 'vinted.image.read': {
        const input = parseOrThrow(ImageReadInputSchema, payload)
        return this.images.read(input.id, input.offset)
      }
      case 'vinted.image.close':
        return this.images.close(parseOrThrow(ImageCloseInputSchema, payload).id)
      case 'vinted.url.inspect': {
        const { url, kind, host, userId } = normalizeMonitorUrl(
          parseOrThrow(UrlInspectInputSchema, payload).url,
        )
        return { url, kind, host, userId }
      }
      default:
        throw invalidRequest('插件不支持该方法')
    }
  }
  /** Manual runs and timer ticks share the same synchronous admission lock. */
  async tick(): Promise<void> {
    if (this.ticking || this.active.size > 0) return
    this.ticking = true
    try {
      await this.ensureReconciled()
      const doc = await this.store.read()
      const now = this.now().getTime()
      const due = doc.monitors
        .filter(
          (m) =>
            m.enabled &&
            (m.lastRunAt === null ||
              now - Date.parse(m.lastRunAt) >= m.intervalMinutes * 60_000),
        )
        .sort((a, b) => (a.lastRunAt ?? '').localeCompare(b.lastRunAt ?? ''))
      for (const m of due) {
        if (this.active.size) break
        try {
          await this.startRun(m.id)
          break
        } catch {
          this.logger.warn('定时采集启动失败', { monitorId: m.id })
        }
      }
    } catch {
      this.logger.error('定时采集无法读取或更新私有存储')
    } finally {
      this.ticking = false
    }
  }
  private async ensureReconciled(): Promise<void> {
    this.reconciled ??= this.reconcile().catch((error: unknown) => {
      this.reconciled = null
      throw error
    })
    await this.reconciled
  }
  private async reconcile(): Promise<void> {
    const doc = await this.store.read()
    if (!doc.runs.some((r) => r.status === 'running')) return
    await this.store.mutate((draft) => {
      for (const r of draft.runs)
        if (r.status === 'running') {
          r.status = 'interrupted'
          r.finishedAt = this.now().toISOString()
          r.error = '插件进程已重启，本次采集被中断'
        }
      for (const m of draft.monitors)
        if (m.lastStatus === 'running') m.lastStatus = 'interrupted'
    })
  }
  private async saveMonitor(payload: unknown) {
    const input = parseOrThrow(MonitorSaveInputSchema, payload)
    const target = normalizeMonitorUrl(input.searchUrl)
    return this.store.mutate((doc) => {
      const existing = input.id === undefined ? undefined : requireMonitor(doc, input.id)
      const proxyId =
        input.proxyId === undefined ? (existing?.proxyId ?? null) : input.proxyId
      selectProxy(doc, proxyId, !input.enabled)
      const now = this.now().toISOString()
      if (existing !== undefined) {
        Object.assign(existing, input, {
          proxyId,
          searchUrl: target.url,
          kind: target.kind,
          host: target.host,
          userId: target.userId,
          updatedAt: now,
        })
        return { item: existing, created: false }
      }
      if (doc.monitors.length >= MAX_MONITORS)
        throw invalidRequest(`监控上限为 ${MAX_MONITORS} 个`)
      const m: MonitorRecord = {
        ...input,
        id: this.idFactory(),
        proxyId,
        searchUrl: target.url,
        kind: target.kind,
        host: target.host,
        userId: target.userId,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        lastStatus: null,
      }
      doc.monitors.unshift(m)
      return { item: m, created: true }
    })
  }
  private async removeMonitor(payload: unknown) {
    const { monitorId } = parseOrThrow(MonitorIdInputSchema, payload)
    return this.store.mutate((doc) => {
      if (this.active.has(monitorId))
        throw invalidRequest('该监控正在采集中，请等本次采集结束后再删除')
      const before = doc.monitors.length
      const source = doc.monitors.find((m) => m.id === monitorId)
      doc.monitors = doc.monitors.filter((m) => m.id !== monitorId)
      for (const item of doc.items) {
        if (item.monitorId === monitorId && source) item.sourceProxyId = source.proxyId
        item.monitorIds = item.monitorIds.filter((id) => id !== monitorId)
        item.associations = item.associations.filter((a) => a.monitorId !== monitorId)
      }
      return { removed: before !== doc.monitors.length }
    })
  }
  private async saveProxy(payload: unknown) {
    const input = parseOrThrow(ProxySaveInputSchema, payload)
    const host = proxyHost(input.host)
    return this.store.mutate((doc) => {
      const previous =
        input.id === undefined ? undefined : doc.proxies.find((p) => p.id === input.id)
      if (input.id !== undefined && !previous) throw invalidRequest('代理不存在')
      const proxy: ProxyRecord = {
        ...previous,
        ...input,
        host,
        id: previous?.id ?? this.idFactory(),
        password: input.password ?? previous?.password ?? '',
      }
      validateProxy({ ...proxy, enabled: true })
      if (previous) Object.assign(previous, proxy)
      else doc.proxies.unshift(proxy)
      return { item: proxyView(proxy), created: !previous }
    })
  }
  private async monitorSeller(payload: unknown) {
    const { itemId } = parseOrThrow(ItemIdInputSchema, payload)
    return this.store.mutate((doc) => {
      const item = requireItem(doc, itemId)
      if (item.userId === null) throw invalidRequest('商品缺少卖家 ID')
      const target = normalizeMonitorUrl(`https://${item.domain}/member/${item.userId}`)
      const existing = doc.monitors
        .filter((m) => m.searchUrl === target.url)
        .sort(
          (a, b) =>
            Number(b.enabled) - Number(a.enabled) ||
            b.createdAt.localeCompare(a.createdAt) ||
            b.id.localeCompare(a.id),
        )[0]
      if (existing) return { monitor: existing, created: false }
      const sources = doc.monitors
        .filter((m) => item.monitorIds.includes(m.id))
        .sort(
          (a, b) =>
            Number(b.enabled) - Number(a.enabled) ||
            (
              item.associations.find((l) => l.monitorId === b.id)?.lastSeenAt ?? ''
            ).localeCompare(
              item.associations.find((l) => l.monitorId === a.id)?.lastSeenAt ?? '',
            ) ||
            b.id.localeCompare(a.id),
        )
      const source = sources.find((m) => {
        try {
          selectProxy(doc, m.proxyId)
          return true
        } catch {
          return false
        }
      })
      if (!source) throw invalidRequest('没有可用的来源监控和代理')
      if (doc.monitors.length >= MAX_MONITORS)
        throw invalidRequest(`监控上限为 ${MAX_MONITORS} 个`)
      const now = this.now().toISOString()
      const monitor: MonitorRecord = {
        id: this.idFactory(),
        name: `卖家 ${item.userId}`,
        searchUrl: target.url,
        kind: target.kind,
        host: target.host,
        userId: target.userId,
        proxyId: source.proxyId,
        intervalMinutes: source.intervalMinutes,
        maxPages: 20,
        perPage: 96,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        lastStatus: null,
      }
      doc.monitors.unshift(monitor)
      return { monitor, created: true }
    })
  }
  private async startRun(monitorId: string): Promise<RunRecord> {
    if (this.active.size > 0) throw invalidRequest('监控正在采集中，请稍后查看记录')
    this.active.add(monitorId)
    try {
      const { run, monitor, proxy } = await this.store.mutate((doc) => {
        const monitor = requireMonitor(doc, monitorId)
        if (!monitor.enabled) throw invalidRequest('请先启用监控再执行')
        const proxy = selectProxy(doc, monitor.proxyId)
        const startedAt = this.now().toISOString()
        const run: RunRecord = {
          id: this.idFactory(),
          monitorId,
          monitorName: monitor.name,
          status: 'running',
          startedAt,
          finishedAt: null,
          ...emptyCounts(),
          error: null,
          scanKey: scanKey(monitor),
        }
        doc.runs.unshift(run)
        // Preserve each monitor's comparable baseline beyond the recent-history cap.
        const baseline = new Set<string>()
        doc.runs = doc.runs.filter((r, index) => {
          const key = `${r.monitorId}:${r.scanKey ?? ''}`
          const needed =
            r.status === 'success' &&
            !r.truncated &&
            !r.failed &&
            !r.userFailed &&
            !r.error &&
            !baseline.has(key)
          if (needed) baseline.add(key)
          return index < MAX_RUNS || needed
        })
        monitor.lastRunAt = startedAt
        monitor.lastStatus = 'running'
        return { run, monitor: structuredClone(monitor), proxy }
      })
      void this.execute(monitor, run, proxy)
      return run
    } catch (error) {
      this.active.delete(monitorId)
      throw error
    }
  }
  private async execute(
    monitor: MonitorRecord,
    run: RunRecord,
    proxy: Readonly<ProxyRecord> | null,
  ): Promise<void> {
    let scope: ReturnType<VintedClient['scope']> | undefined
    let counts = emptyCounts()
    let outcome: CollectResult
    try {
      scope = this.client.scope?.(proxy)
      const client = scope?.client ?? this.client
      try {
        outcome = await collect({
          monitor,
          target: normalizeMonitorUrl(monitor.searchUrl),
          client,
          hooks: {
            applyPage: (items) =>
              this.store.mutate((doc) =>
                applyItems(doc, monitor, items, this.now().toISOString()),
              ),
            progress: async (progress) => {
              counts = progress
              await this.store.mutate((doc) => {
                const r = doc.runs.find((r) => r.id === run.id)
                if (r) Object.assign(r, progress)
              })
            },
            refreshUser: (id, remaining) =>
              this.refreshUser(client, monitor.host, id, remaining),
          },
          ...(this.pause ? { pause: this.pause } : {}),
        })
      } catch (error) {
        outcome = {
          status: counts.pages > 0 ? 'partial' : 'failed',
          counts: { ...counts, failed: counts.failed + 1 },
          error: describeFailure(error),
          seenItemIds: [],
        }
      }
      await this.store.mutate((doc) => {
        const current = doc.runs.find((r) => r.id === run.id)
        if (current) {
          Object.assign(current, outcome.counts, {
            status: outcome.status,
            finishedAt: this.now().toISOString(),
            error: outcome.error,
            seenItemIds: outcome.seenItemIds,
          })
          markMissing(doc, current, this.now().toISOString())
        }
        const m = doc.monitors.find((m) => m.id === monitor.id)
        if (m) m.lastStatus = outcome.status
      })
    } catch {
      this.logger.error('采集结束状态未能保存，请检查私有存储', { runId: run.id })
      try {
        await this.store.mutate((doc) => {
          const r = doc.runs.find((r) => r.id === run.id)
          if (r) {
            r.status = 'failed'
            r.error = '采集失败或结果写入失败'
            r.finishedAt = this.now().toISOString()
          }
          const m = doc.monitors.find((m) => m.id === monitor.id)
          if (m) m.lastStatus = 'failed'
        })
      } catch {
        this.logger.error('无法写入失败状态，重启后将标记为中断', { runId: run.id })
      }
    } finally {
      try {
        await scope?.transport.close()
      } catch {
        this.logger.warn('采集连接清理失败')
      } finally {
        this.active.delete(monitor.id)
      }
    }
  }
  private async refreshUser(
    client: VintedClient,
    domain: string,
    userId: string,
    remaining: number,
  ): Promise<boolean> {
    const existing = (await this.store.read()).sellers.find(
      (s) => s.domain === domain && s.externalId === userId,
    )
    if (existing?.collectedAt) return true
    const checkedAt = this.now().toISOString()
    let profile: Record<string, unknown> | null = null
    let error: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (remaining <= 0) throw new Error('budget')
      profile = await Promise.race([
        client.user(domain, userId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('budget')), remaining)
        }),
      ])
    } catch (cause) {
      error = describeFailure(cause)
    } finally {
      clearTimeout(timer)
    }
    await this.store.mutate((doc) => {
      const at = doc.sellers.findIndex(
        (s) => s.domain === domain && s.externalId === userId,
      )
      const previous = doc.sellers[at]
      if (previous && previous.checkedAt > checkedAt) return
      const next =
        profile === null && previous
          ? { ...previous, checkedAt, error }
          : { ...previous, ...sellerRecord(domain, userId, checkedAt, profile, error) }
      if (at >= 0) doc.sellers[at] = next
      else doc.sellers.push(next)
    })
    return error === null
  }
}
