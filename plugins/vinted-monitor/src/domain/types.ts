import type { MonitorKind } from './urls.js'

export type RunStatus = 'running' | 'success' | 'partial' | 'failed' | 'interrupted'

export interface MonitorRecord {
  id: string
  name: string
  /** Canonical URL produced by `normalizeMonitorUrl`. */
  searchUrl: string
  kind: MonitorKind
  host: string
  /** Wardrobe owner for `member` monitors, otherwise null. */
  userId: string | null
  intervalMinutes: number
  maxPages: number
  perPage: number
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
  lastStatus: RunStatus | null
}

export interface RunRecord {
  id: string
  monitorId: string
  /** Copied so the history still reads correctly after a rename or delete. */
  monitorName: string
  status: RunStatus
  startedAt: string
  finishedAt: string | null
  discovered: number
  inserted: number
  updated: number
  skipped: number
  failed: number
  truncated: boolean
  pages: number
  error: string | null
}

export interface ItemRecord {
  id: string
  monitorId: string
  title: string
  price: string
  currency: string
  brand: string
  size: string
  condition: string
  url: string
  imageUrl: string
  seller: string
  listedAt: string | null
  firstSeenAt: string
  lastSeenAt: string
}

/** Run counts the collector reports once a collection finishes. */
export interface CollectionCounts {
  discovered: number
  inserted: number
  updated: number
  skipped: number
  failed: number
  truncated: boolean
  pages: number
}

export function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === 'running' ||
    value === 'success' ||
    value === 'partial' ||
    value === 'failed' ||
    value === 'interrupted'
  )
}
