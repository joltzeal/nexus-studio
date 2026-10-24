export const VINTED_PLUGIN_ID = 'studio.vinted-monitor'
export const VINTED_CAPABILITY = 'monitor.collector'

export type MonitorKind = 'catalog' | 'member'
export type RunStatus = 'running' | 'success' | 'partial' | 'failed' | 'interrupted'
export type AvailabilityStatus = 'unknown' | 'pending' | 'available' | 'sold' | 'ignored'
export type ReviewStatus = Exclude<AvailabilityStatus, 'unknown'>
export type ItemOrder = 'collected_desc' | 'favourite_asc' | 'favourite_desc'
export type FavouriteOperator =
  'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'between' | 'isNull' | 'notNull'

export interface MonitorProxy {
  id: string
  name: string
  scheme: 'http' | 'https' | 'socks5' | 'socks5h'
  host: string
  port: number
  username: string
  hasPassword: boolean
  enabled: boolean
}

export type ProxyInput = Omit<MonitorProxy, 'id' | 'hasPassword'> & {
  id?: string
  password?: string
}

export interface ProxyList {
  items: MonitorProxy[]
  defaultProxyId: string | null
  storageDurable: boolean
}

export interface Monitor {
  id: string
  name: string
  searchUrl: string
  kind: MonitorKind
  host: string
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

export interface Run {
  id: string
  monitorId: string
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
}

export interface ItemSummary {
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
  sellerProfile: SellerSummary | null
  favouriteCount: number | null
  viewCount: number | null
  starred: boolean
  availabilityStatus: AvailabilityStatus
  missingSince: string | null
  missingMonitorId: string | null
  statusCheckedAt: string | null
  statusNote: string | null
  collectedAt: string
  listedAt: string | null
  firstSeenAt: string
  lastSeenAt: string
}

export interface Item extends ItemSummary {
  sellerProfile: Seller | null
  images: string[]
  detail: Record<string, unknown>
}

export type SellerSummary = Omit<Seller, 'detail'>

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

export interface Pagination {
  page: number
  pageSize: number
}

export interface ItemFilters {
  monitorId?: string
  keyword?: string
  externalId?: string
  availabilityStatus?: AvailabilityStatus
  starred?: boolean
  order?: ItemOrder
  favouriteCountOp?: FavouriteOperator
  favouriteCount?: number
  favouriteCountStart?: number
  favouriteCountEnd?: number
}

export interface MonitorList {
  items: Monitor[]
  total: number
  itemCounts: Record<string, number>
  storageDurable: boolean
  page?: number
  pageSize?: number
  totalPages?: number
}

export interface RunList {
  items: Run[]
  total: number
  page?: number
  pageSize?: number
  totalPages?: number
}

export interface ItemList {
  items: ItemSummary[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export interface MonitorInput {
  id?: string
  name: string
  searchUrl: string
  proxyId: string | null
  intervalMinutes: number
  maxPages: number
  perPage: number
  enabled: boolean
}

export const DEFAULT_MONITOR: Omit<MonitorInput, 'id'> = {
  name: '',
  searchUrl: '',
  proxyId: null,
  intervalMinutes: 10,
  maxPages: 3,
  perPage: 20,
  enabled: true,
}

/** Tauri rejects with the command's `Err(String)`, which is not an `Error`. */
export function message(error: unknown): string {
  return typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '请求失败，请稍后重试'
}

export function kindText(kind: MonitorKind): string {
  return kind === 'member' ? '用户商品监控' : '搜索商品监控'
}

export function runStatusText(status: RunStatus): string {
  if (status === 'success') return '成功'
  if (status === 'partial') return '部分成功'
  if (status === 'failed') return '失败'
  if (status === 'interrupted') return '已中断'
  return '采集中'
}

export function intervalText(minutes: number): string {
  if (minutes < 60) return `${String(minutes)} 分钟`
  if (minutes === 60) return '1 小时'
  if (minutes % 60 === 0) return `${String(minutes / 60)} 小时`
  return `${String(Math.floor(minutes / 60))} 小时 ${String(minutes % 60)} 分`
}

export function formatTime(iso: string | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function priceText(item: Pick<ItemSummary, 'price' | 'currency'>): string {
  if (item.price === '') return '价格未标注'
  if (item.currency === '') return item.price
  return `${item.price} ${item.currency}`
}

/** How a run reads in one line: what it found and what changed. */
export function runSummary(run: Run): string {
  const parts = [`发现 ${String(run.discovered)}`, `新增 ${String(run.inserted)}`]
  if (run.updated > 0) parts.push(`更新 ${String(run.updated)}`)
  if (run.userFailed > 0) parts.push(`卖家失败 ${String(run.userFailed)}`)
  if (run.skipped > 0) parts.push(`跳过 ${String(run.skipped)}`)
  if (run.failed > 0) parts.push(`失败 ${String(run.failed)}`)
  if (run.truncated) parts.push('已达页数上限')
  return parts.join(' · ')
}

export const AVAILABILITY_LABELS: Record<AvailabilityStatus, string> = {
  unknown: '未核查',
  pending: '待核查',
  available: '仍在售',
  sold: '已售出',
  ignored: '已忽略',
}
