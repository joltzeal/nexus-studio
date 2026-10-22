export const VINTED_PLUGIN_ID = 'studio.vinted-monitor'
export const VINTED_CAPABILITY = 'monitor.collector'

export type MonitorKind = 'catalog' | 'member'
export type RunStatus = 'running' | 'success' | 'partial' | 'failed' | 'interrupted'

export interface Monitor {
  id: string
  name: string
  searchUrl: string
  kind: MonitorKind
  host: string
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
  skipped: number
  failed: number
  truncated: boolean
  pages: number
  error: string | null
}

export interface Item {
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

export interface MonitorList {
  items: Monitor[]
  total: number
  itemCounts: Record<string, number>
  storageDurable: boolean
}

export interface RunList {
  items: Run[]
  total: number
}

export interface ItemList {
  items: Item[]
  total: number
  page: number
  pageSize: number
}

export interface MonitorInput {
  id?: string
  name: string
  searchUrl: string
  intervalMinutes: number
  maxPages: number
  perPage: number
  enabled: boolean
}

export const DEFAULT_MONITOR: Omit<MonitorInput, 'id'> = {
  name: '',
  searchUrl: '',
  intervalMinutes: 10,
  maxPages: 3,
  perPage: 20,
  enabled: true,
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}

export function kindText(kind: MonitorKind): string {
  return kind === 'member' ? '会员衣柜' : '目录搜索'
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

export function priceText(item: Item): string {
  if (item.price === '') return '价格未标注'
  if (item.currency === '') return item.price
  return `${item.price} ${item.currency}`
}

/** How a run reads in one line: what it found and what changed. */
export function runSummary(run: Run): string {
  const parts = [`发现 ${String(run.discovered)}`, `新增 ${String(run.inserted)}`]
  if (run.updated > 0) parts.push(`更新 ${String(run.updated)}`)
  if (run.skipped > 0) parts.push(`跳过 ${String(run.skipped)}`)
  if (run.failed > 0) parts.push(`失败 ${String(run.failed)}`)
  if (run.truncated) parts.push('已达页数上限')
  return parts.join(' · ')
}
