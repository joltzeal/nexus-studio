export interface ProfileInfo { username: string; nickname: string; avatar: string; money: number }
export interface Sim8Config { baseUrl: string; hasToken: boolean; profile: ProfileInfo | null; profileAt: string | null; records: number; storageDurable: boolean }
export interface CategoryItem { id: number; name: string; count: number | null }
export interface AppItem { id: number; cateId: number | null; name: string; price: number; stock: number | null }
export interface PrefixItem { prefix: string; num: number }
export interface PrefixReport { items: PrefixItem[]; count: number; num: number }
export interface SmsRead { code: string | null; body: string; truncated: boolean; contentType: string; fetchedAt: string }
export interface SmsRecord {
  tel: string; token: string; api: string; apiId: number | null; ordernum: string; appId: number | null;
  cateId: number | null; type: number | null; endTime: string; remark: string; status: number | null;
  renew: number | null; smsCount: number | null; voiceCount: number | null; addedAt: string; updatedAt: string;
  lastRead: SmsRead | null;
}
export interface RecordList { items: SmsRecord[]; total: number; matched: number; storageDurable: boolean }
export interface ExpiryReminder { tel: string; expiresAt: string; checkedAt: string | null }
export interface ExpirySnapshot { items: ExpiryReminder[]; pendingTels: string[]; failed: number; storageDurable: boolean }
export interface OrderItem { ordernum: string; allocationStatus: string; requestedNum: number | null; allocatedNum: number | null; expireAt: string; failureReason: string }
export interface AllocationState { ordernum: string; allocationStatus: string; requestedNum: number | null; allocatedNum: number | null; apiCount: number | null; expireAt: string; failureReason: string }
export interface FilterAppItem { id: number; name: string; price: number; min: number | null; max: number | null }
export interface FilterDetail {
  orderId: number; ordernum: string; name: string; countryCode: string; country: string; appId: number | null;
  price: number; num: number | null; valid: number | null; money: number; fileUrl: string; taskFileUrl: string;
  taskRemark: string; status: number | null; createTime: string; updateTime: string;
}
export interface PurchaseResult { ordernum: string; apiCount: number; requested: number; total: number; truncated: boolean; records: SmsRecord[] }
export interface OrderApisResult { ordernum: string; total: number; truncated: boolean; records: SmsRecord[]; allocation: AllocationState }
export interface RenewReport { success: number; failed: number; failedList: string[]; total: number; records: SmsRecord[] }

export const APP_TYPES = [
  { value: '1', label: '首次卡' }, { value: '2', label: '重启卡' }, { value: '3', label: '续费卡' },
] as const
export const EXPIRY_OPTIONS = [
  { value: '0', label: '随机' }, { value: '1', label: '5–30 天' }, { value: '2', label: '10–30 天' },
  { value: '3', label: '15–30 天' }, { value: '4', label: '30–60 天' }, { value: '5', label: '60–80 天' },
  { value: '6', label: '大于 80 天' },
] as const
export const ALLOCATION_LABELS: Record<string, string> = { pending: '排队中', processing: '分配中', completed: '已分配', expired: '已过期' }
export const FILTER_STATUS_LABELS: Record<string, string> = { '1': '检测中', '2': '已完成', '3': '已失败' }
export function formatMoney(value: number) { return `¥${value.toFixed(2)}` }
export function shortTime(value: string) {
  if (!value) return '—'
  const date = new Date(value.replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? value.replace('T', ' ').slice(0, 16) : date.toLocaleString('zh-CN', { hour12: false })
}
export function appTypeLabel(value: number | null) { return APP_TYPES.find((entry) => entry.value === String(value))?.label ?? '—' }
export function allocationLabel(value: string) { return ALLOCATION_LABELS[value] ?? (value || '—') }
export function filterStatusLabel(value: number | null) { return value === null ? '—' : FILTER_STATUS_LABELS[String(value)] ?? `状态 ${value}` }
export function recordExpired(record: SmsRecord, now = Date.now()) {
  const at = Date.parse(record.endTime.replace(' ', 'T'))
  return Number.isNaN(at) ? record.status === 2 : at <= now
}
