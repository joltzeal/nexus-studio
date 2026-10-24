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
  proxyId: string | null
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
  userFailed: number
  skipped: number
  failed: number
  truncated: boolean
  pages: number
  error: string | null
  /** Only complete comparable scans may serve as a missing-item baseline. */
  scanKey?: string | undefined
  seenItemIds?: string[] | undefined
}

export interface ItemRecord {
  id: string
  externalId: string
  domain: string
  monitorId: string
  monitorIds: string[]
  title: string
  price: string
  currency: string
  brand: string
  size: string
  condition: string
  url: string
  imageUrl: string
  seller: string
  userId: string | null
  sellerProfile: Seller | null
  images: string[]
  detail: Record<string, unknown>
  favouriteCount: number | null
  viewCount: number | null
  starred: boolean
  availabilityStatus: 'unknown' | 'pending' | 'available' | 'sold' | 'ignored'
  missingSince: string | null
  missingMonitorId: string | null
  statusCheckedAt: string | null
  statusNote: string | null
  collectedAt: string
  listedAt: string | null
  firstSeenAt: string
  lastSeenAt: string
}

export interface StoredItem extends ItemRecord {
  deletedAt: string | null
  sourceProxyId: string | null
  associations: { monitorId: string; firstSeenAt: string; lastSeenAt: string }[]
}

export interface Seller {
  id: string
  externalId: string
  domain: string
  login: string | null
  name: string | null
  profileUrl: string
  avatarUrl: string | null
  country: string | null
  city: string | null
  feedbackReputation: number | null
  feedbackCount: number | null
  followersCount: number | null
  itemCount: number | null
  verification: Record<
    string,
    { valid: boolean | null; available: boolean | null; verifiedAt: string | null }
  >
  lastLogedOnTs: string | null
  updatedOn: string | null
  collectedAt: string | null
  checkedAt: string
  error: string | null
  detail: Record<string, unknown> | null
}

export type SellerSummary = Omit<Seller, 'detail'>

export type ItemSummary = Omit<ItemRecord, 'images' | 'detail' | 'sellerProfile'> & {
  sellerProfile: SellerSummary | null
}

export interface ProxyRecord {
  id: string
  name: string
  scheme: 'http' | 'https' | 'socks5' | 'socks5h'
  host: string
  port: number
  username: string
  password: string
  enabled: boolean
}

export type ProxyView = Omit<ProxyRecord, 'password'> & { hasPassword: boolean }

/** Run counts the collector reports once a collection finishes. */
export interface CollectionCounts {
  discovered: number
  inserted: number
  updated: number
  userFailed: number
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
