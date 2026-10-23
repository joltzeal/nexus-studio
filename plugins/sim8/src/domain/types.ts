/**
 * DTOs for the SIM8 API. Every field the provider documents as loosely typed
 * (`items: {}`, `url_list: []`) is normalized at the boundary, so the rest of
 * the plugin never has to defend against an unexpected shape twice.
 */

/** 1: 首次卡, 2: 重启卡, 3: 续费卡. */
export type AppType = 1 | 2 | 3

export interface ProfileInfo {
  username: string
  nickname: string
  avatar: string
  money: number
}

export interface CategoryItem {
  id: number
  name: string
  /** How many projects sit in the category, when the provider says so. */
  count: number | null
}

export interface AppItem {
  id: number
  cateId: number | null
  name: string
  price: number
  /** Remaining stock; null when the answer does not carry it. */
  stock: number | null
}

export interface PrefixItem {
  prefix: string
  num: number
}

export interface PrefixReport {
  items: PrefixItem[]
  count: number
  num: number
}

/** What one row of `buy/create` or `order/api` says about a number. */
export interface PurchasedApi {
  tel: string
  token: string
  api: string
  apiId: number | null
  ordernum: string
  appId: number | null
  cateId: number | null
  type: number | null
  endTime: string
  remark: string
  status: number | null
  renew: number | null
  smsCount: number | null
  voiceCount: number | null
}

/** One read of a number's record endpoint. */
export interface SmsRead {
  code: string | null
  body: string
  truncated: boolean
  contentType: string
  fetchedAt: string
}

/**
 * A purchased number, kept locally so the page has a list to work with: the
 * provider's own order endpoints are paginated and searchable by order number
 * only, which is not a browsing experience.
 */
export interface SmsRecord extends PurchasedApi {
  addedAt: string
  updatedAt: string
  lastRead: SmsRead | null
}

export interface OrderItem {
  ordernum: string
  allocationStatus: string
  requestedNum: number | null
  allocatedNum: number | null
  expireAt: string
  failureReason: string
}

export interface AllocationState {
  ordernum: string
  allocationStatus: string
  requestedNum: number | null
  allocatedNum: number | null
  apiCount: number | null
  expireAt: string
  failureReason: string
}

export interface FilterAppItem {
  id: number
  name: string
  price: number
  min: number | null
  max: number | null
}

export interface FilterDetail {
  orderId: number
  ordernum: string
  name: string
  countryCode: string
  country: string
  appId: number | null
  price: number
  num: number | null
  valid: number | null
  money: number
  fileUrl: string
  taskFileUrl: string
  taskRemark: string
  /** 1: 检测中, 2: 已完成, 3: 已失败. */
  status: number | null
  createTime: string
  updateTime: string
}

export interface RenewReport {
  success: number
  failed: number
  failedList: string[]
  total: number
  records: SmsRecord[]
}
