import { UpstreamError, upstreamErrorText } from '../domain/errors.js'
import type { DraftItem } from '../domain/items.js'
import type { CollectionCounts, MonitorRecord, RunStatus } from '../domain/types.js'
import type { MonitorTarget } from '../domain/urls.js'
import type { VintedClient } from './vinted.js'

/** Politeness gap between pages: the catalogue endpoint throttles bursts. */
export const PAGE_PAUSE_MS = 400

export interface CollectHooks {
  /** Persists one page of listings and reports how many were new. */
  applyPage(
    items: DraftItem[],
  ): Promise<{ inserted: number; updated: number; skipped?: number; users?: string[] }>
  /** Called after every page so the run record shows live progress. */
  progress(counts: CollectionCounts): Promise<void>
  refreshUser?(userId: string, timeoutMs: number): Promise<boolean>
}

export interface CollectResult {
  status: Extract<RunStatus, 'success' | 'partial' | 'failed'>
  counts: CollectionCounts
  error: string | null
  seenItemIds: string[]
}

export interface CollectOptions {
  monitor: MonitorRecord
  target: MonitorTarget
  client: VintedClient
  hooks: CollectHooks
  pause?: (milliseconds: number) => Promise<void>
}

export function describeFailure(error: unknown): string {
  if (error instanceof UpstreamError) return upstreamErrorText(error)
  if (error instanceof Error && error.message !== '') return '采集过程中出现意外错误'
  return '采集失败'
}

function zeroCounts(): CollectionCounts {
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

/**
 * Walks pages 1..maxPages for one monitor.
 *
 * A page failure stops the walk: Vinted either throttles the whole session or
 * serves normally, so retrying page 7 after page 6 was rejected only wastes the
 * remaining budget. Whatever was collected before the failure is kept and the
 * run is reported as partial.
 */
export async function collect(options: CollectOptions): Promise<CollectResult> {
  const { monitor, target, client, hooks } = options
  const pause =
    options.pause ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      }))

  const counts = zeroCounts()
  const seen = new Set<string>()
  const users = new Set<string>()
  let failure: string | null = null

  for (let page = 1; page <= monitor.maxPages; page += 1) {
    let result
    try {
      result = await client.items(target, page, monitor.perPage)
    } catch (error) {
      failure = describeFailure(error)
      counts.failed += 1
      break
    }

    counts.pages = page
    if (
      page > 1 &&
      result.items.length > 0 &&
      result.items.every((item) => seen.has(item.id))
    ) {
      failure = 'Vinted 返回了重复的分页，无法确认扫描完整'
      counts.failed += 1
      break
    }
    const fresh: DraftItem[] = []
    for (const item of result.items) {
      if (seen.has(item.id)) {
        counts.skipped += 1
        continue
      }
      seen.add(item.id)
      fresh.push(item)
    }
    counts.discovered += fresh.length
    counts.skipped += result.invalid
    if (result.invalid > 0) {
      counts.failed += result.invalid
      failure = '部分商品数据无效，未进行缺失判定'
    }

    if (fresh.length > 0) {
      const applied = await hooks.applyPage(fresh)
      counts.inserted += applied.inserted
      counts.updated += applied.updated
      counts.skipped += applied.skipped ?? 0
      for (const userId of applied.users ?? []) users.add(userId)
    }
    await hooks.progress({ ...counts })

    if (!result.hasMore) break
    if (page === monitor.maxPages) {
      counts.truncated = true
      break
    }
    await pause(PAGE_PAUSE_MS)
  }

  // List persistence always precedes profile enrichment; slow profiles cannot truncate pages.
  const deadline = Date.now() + 120_000
  for (const userId of users) {
    if (
      hooks.refreshUser &&
      !(await hooks.refreshUser(userId, Math.max(0, deadline - Date.now())))
    ) {
      counts.userFailed += 1
      failure ??= '部分卖家资料获取失败，已保留商品'
    }
  }
  const seenItemIds = [...seen].map((id) => `${target.host}:${id}`)
  if (counts.pages === 0) {
    return { status: 'failed', counts, error: failure ?? '没有取到任何商品', seenItemIds }
  }
  return {
    status: failure === null && !counts.truncated ? 'success' : 'partial',
    counts,
    error: failure,
    seenItemIds,
  }
}
