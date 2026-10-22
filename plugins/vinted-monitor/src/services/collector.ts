import { UpstreamError, upstreamReasonText } from '../domain/errors.js'
import type { DraftItem } from '../domain/items.js'
import type { CollectionCounts, MonitorRecord, RunStatus } from '../domain/types.js'
import type { MonitorTarget } from '../domain/urls.js'
import type { VintedClient } from './vinted.js'

/** Politeness gap between pages: the catalogue endpoint throttles bursts. */
export const PAGE_PAUSE_MS = 400

export interface CollectHooks {
  /** Persists one page of listings and reports how many were new. */
  applyPage(items: DraftItem[]): Promise<{ inserted: number; updated: number }>
  /** Called after every page so the run record shows live progress. */
  progress(counts: CollectionCounts): Promise<void>
}

export interface CollectResult {
  status: Extract<RunStatus, 'success' | 'partial' | 'failed'>
  counts: CollectionCounts
  error: string | null
}

export interface CollectOptions {
  monitor: MonitorRecord
  target: MonitorTarget
  client: VintedClient
  hooks: CollectHooks
  pause?: (milliseconds: number) => Promise<void>
}

export function describeFailure(error: unknown): string {
  if (error instanceof UpstreamError) return upstreamReasonText(error.reason)
  if (error instanceof Error && error.message !== '') return '采集过程中出现意外错误'
  return '采集失败'
}

function zeroCounts(): CollectionCounts {
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

    if (fresh.length > 0) {
      const applied = await hooks.applyPage(fresh)
      counts.inserted += applied.inserted
      counts.updated += applied.updated
    }
    await hooks.progress({ ...counts })

    if (!result.hasMore) break
    if (page === monitor.maxPages) {
      counts.truncated = true
      break
    }
    await pause(PAGE_PAUSE_MS)
  }

  if (counts.pages === 0) {
    return { status: 'failed', counts, error: failure ?? '没有取到任何商品' }
  }
  return {
    status: failure === null ? 'success' : 'partial',
    counts,
    error: failure,
  }
}
