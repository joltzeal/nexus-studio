import type { AiImageHandoff, GenerationSource } from '../ai-image/types.ts'

export const VINTED_PLUGIN_ID = 'studio.vinted-monitor'
export const VINTED_CAPABILITY = 'monitor.collector'
export const VINTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const
export const VINTED_IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const VINTED_IMAGE_MAX_CHUNK = 256 * 1024
export const VINTED_PAGE_SIZE = 20

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

export interface ProxyInput {
  id?: string
  name: string
  scheme: MonitorProxy['scheme']
  host: string
  port: number
  username: string
  password?: string
  enabled: boolean
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

export interface SellerSummary {
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
}

export interface Seller extends SellerSummary {
  detail: Record<string, unknown> | null
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

export interface Pagination {
  page: number
  pageSize: number
}

export interface Page<T> extends Pagination {
  items: T[]
  total: number
  totalPages: number
}

export interface MonitorList {
  items: Monitor[]
  total: number
  itemCounts: Record<string, number>
  storageDurable: boolean
}

export interface ProxyList {
  items: MonitorProxy[]
  defaultProxyId: string | null
  storageDurable: boolean
}

export interface UrlInspection {
  kind: MonitorKind
  host: string
  userId: string | null
  url: string
}

export const EMPTY_FILTERS = {
  monitorId: '',
  keyword: '',
  externalId: '',
  availabilityStatus: '',
  starred: '',
  order: 'collected_desc',
  favouriteCountOp: '',
  favouriteCount: '',
  favouriteCountEnd: '',
} as const

export type FilterDraft = { [Key in keyof typeof EMPTY_FILTERS]: string }

export const AVAILABILITY_LABELS: Record<AvailabilityStatus, string> = {
  unknown: '未核查',
  pending: '待核查',
  available: '仍在售',
  sold: '已售出',
  ignored: '已忽略',
}

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: '采集中',
  success: '成功',
  partial: '部分成功',
  failed: '失败',
  interrupted: '已中断',
}

const FAVOURITE_OPERATORS: { value: FavouriteOperator; label: string }[] = [
  { value: 'eq', label: '等于' },
  { value: 'ne', label: '不等于' },
  { value: 'gt', label: '大于' },
  { value: 'ge', label: '大于等于' },
  { value: 'lt', label: '小于' },
  { value: 'le', label: '小于等于' },
  { value: 'between', label: '介于' },
  { value: 'isNull', label: '未提供' },
  { value: 'notNull', label: '已提供' },
]

function count(value: string): number {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) throw new Error('收藏数需要填写非负整数')
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) throw new Error('收藏数超出范围')
  return parsed
}

export function itemFilterParams(draft: FilterDraft): ItemFilters {
  const result: ItemFilters = {}
  if (draft.monitorId) result.monitorId = draft.monitorId
  if (draft.keyword.trim()) result.keyword = draft.keyword.trim()
  if (draft.externalId.trim()) {
    if (!/^\d{1,32}$/.test(draft.externalId.trim()))
      throw new Error('来源商品 ID 需要填写最多 32 位数字')
    result.externalId = draft.externalId.trim()
  }
  if (draft.availabilityStatus)
    result.availabilityStatus = draft.availabilityStatus as AvailabilityStatus
  if (draft.starred) result.starred = draft.starred === 'true'
  if (draft.order && draft.order !== 'collected_desc')
    result.order = draft.order as ItemOrder
  if (draft.favouriteCountOp) {
    const operator = FAVOURITE_OPERATORS.find(
      ({ value }) => value === draft.favouriteCountOp,
    )?.value
    if (!operator) throw new Error('收藏数筛选方式无效')
    result.favouriteCountOp = operator
    if (operator === 'between') {
      const start = draft.favouriteCount.trim() ? count(draft.favouriteCount) : undefined
      const end = draft.favouriteCountEnd.trim()
        ? count(draft.favouriteCountEnd)
        : undefined
      if (start === undefined && end === undefined)
        throw new Error('请至少填写一个收藏数区间边界')
      if (start !== undefined && end !== undefined && start > end)
        throw new Error('收藏数下限不能大于上限')
      if (start !== undefined) result.favouriteCountStart = start
      if (end !== undefined) result.favouriteCountEnd = end
    } else if (operator !== 'isNull' && operator !== 'notNull') {
      result.favouriteCount = count(draft.favouriteCount)
    }
  }
  return result
}

export function safeImageUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      /^(?:images\.vinted\.net|images(?:[0-9]|[1-9][0-9])\.vinted\.net)$/i.test(
        url.hostname,
      )
      ? url.href
      : null
  } catch {
    return null
  }
}

export function itemReferencePhotos(item: Pick<Item, 'images' | 'imageUrl'>): string[] {
  return [...new Set([...item.images, item.imageUrl].filter((url) => safeImageUrl(url)))]
}

export function itemHandoff(
  item: Pick<Item, 'id' | 'title' | 'url' | 'brand' | 'size' | 'condition' | 'detail'>,
  images: readonly string[],
): AiImageHandoff {
  const fields: [string, unknown][] = [
    ['标题', item.title],
    ['品牌', item.brand],
    ['尺码', item.size],
    ['成色', item.condition],
    ['描述', item.detail.description],
  ]
  const initialPrompt = fields
    .flatMap(([label, value]) =>
      typeof value === 'string' && value.trim() ? [`${label}：${value.trim()}`] : [],
    )
    .join('\n')
  const source: GenerationSource = {
    pluginId: VINTED_PLUGIN_ID,
    itemId: item.id,
    title: item.title || '未命名商品',
    url: item.url,
  }
  return {
    presentation: 'dialog',
    images: [...images],
    source,
    title: item.title,
    initialPrompt,
  }
}

export function errorMessage(cause: unknown): string {
  return typeof cause === 'string'
    ? cause
    : cause instanceof Error
      ? cause.message
      : '请求失败，请稍后重试。'
}

export function formatTime(value: string | null): string {
  if (value === null) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '时间未知'
    : date.toLocaleString('zh-CN', { hour12: false })
}

export function monitorKindLabel(kind: MonitorKind): string {
  return kind === 'member' ? '用户衣柜' : '搜索目录'
}
