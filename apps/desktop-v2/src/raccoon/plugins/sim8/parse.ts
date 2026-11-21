import type {
  AllocationState,
  AppItem,
  CategoryItem,
  ExpiryReminder,
  ExpirySnapshot,
  FilterAppItem,
  FilterDetail,
  OrderApisResult,
  OrderItem,
  PrefixReport,
  PurchaseResult,
  RecordList,
  RenewReport,
  Sim8Config,
  SmsRead,
  SmsRecord,
} from './types'

const invalid = () => new Error('SIM8 返回的数据格式无效，请刷新或更新插件后重试。')

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw invalid()
  return value
}
function number(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) throw invalid()
  return value
}
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw invalid()
  return value
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid()
  return value
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value)
}
function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value)
}
function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw invalid()
  return value.map(parse)
}

export function parseConfig(value: unknown): Sim8Config {
  const row = object(value)
  let profile: Sim8Config['profile'] = null
  if (row.profile !== null) {
    const source = object(row.profile)
    profile = {
      username: text(source.username),
      nickname: text(source.nickname),
      avatar: text(source.avatar),
      money: number(source.money),
    }
  }
  return {
    baseUrl: text(row.baseUrl),
    hasToken: bool(row.hasToken),
    profile,
    profileAt: nullableText(row.profileAt),
    records: integer(row.records),
    storageDurable: bool(row.storageDurable),
  }
}

export function parseCategory(value: unknown): CategoryItem {
  const row = object(value)
  return {
    id: integer(row.id, 1),
    name: text(row.name),
    count: nullableInteger(row.count),
  }
}

export function parseApp(value: unknown): AppItem {
  const row = object(value)
  return {
    id: integer(row.id, 1),
    cateId: nullableInteger(row.cateId),
    name: text(row.name),
    price: number(row.price),
    stock: nullableInteger(row.stock),
  }
}

export function parseSmsRead(value: unknown): SmsRead {
  const row = object(value)
  return {
    code: nullableText(row.code),
    body: text(row.body),
    truncated: bool(row.truncated),
    contentType: text(row.contentType),
    fetchedAt: text(row.fetchedAt),
  }
}

export function parseSmsRecord(value: unknown): SmsRecord {
  const row = object(value)
  return {
    tel: text(row.tel),
    token: text(row.token),
    api: text(row.api),
    apiId: nullableInteger(row.apiId),
    ordernum: text(row.ordernum),
    appId: nullableInteger(row.appId),
    cateId: nullableInteger(row.cateId),
    type: nullableInteger(row.type),
    endTime: text(row.endTime),
    remark: text(row.remark),
    status: nullableInteger(row.status),
    renew: nullableInteger(row.renew),
    smsCount: nullableInteger(row.smsCount),
    voiceCount: nullableInteger(row.voiceCount),
    addedAt: text(row.addedAt),
    updatedAt: text(row.updatedAt),
    lastRead: row.lastRead === null ? null : parseSmsRead(row.lastRead),
  }
}

export function parseRecordList(value: unknown): RecordList {
  const row = object(value)
  const items = array(row.items, parseSmsRecord)
  const total = integer(row.total)
  const matched = integer(row.matched)
  if (items.length > total || total > 2000 || matched < items.length) throw invalid()
  if (new Set(items.map((item) => item.tel)).size !== items.length) throw invalid()
  return { items, total, matched, storageDurable: bool(row.storageDurable) }
}

export function parseCategories(value: unknown) {
  const row = object(value)
  const items = array(row.items, parseCategory)
  if (new Set(items.map((item) => item.id)).size !== items.length) throw invalid()
  return { items, total: integer(row.total) }
}

export function parseApps(value: unknown) {
  const row = object(value)
  const items = array(row.items, parseApp)
  if (new Set(items.map((item) => item.id)).size !== items.length) throw invalid()
  return { items, total: integer(row.total) }
}

export function parsePrefixes(value: unknown): PrefixReport {
  const row = object(value)
  return {
    items: array(row.items, (item) => {
      const entry = object(item)
      return { prefix: text(entry.prefix), num: integer(entry.num) }
    }),
    count: integer(row.count),
    num: integer(row.num),
  }
}

export function parseAllocation(value: unknown): AllocationState {
  const row = object(value)
  return {
    ordernum: text(row.ordernum),
    allocationStatus: text(row.allocationStatus),
    requestedNum: nullableInteger(row.requestedNum),
    allocatedNum: nullableInteger(row.allocatedNum),
    apiCount: nullableInteger(row.apiCount),
    expireAt: text(row.expireAt),
    failureReason: text(row.failureReason),
  }
}

export function parsePurchase(value: unknown): PurchaseResult {
  const row = object(value)
  const records = array(row.records, parseSmsRecord)
  const requested = integer(row.requested, 1)
  const total = integer(row.total)
  if (total < records.length || total > requested) throw invalid()
  return {
    ordernum: text(row.ordernum),
    apiCount: integer(row.apiCount),
    requested,
    total,
    truncated: bool(row.truncated),
    records,
  }
}

export function parseOrders(value: unknown) {
  const row = object(value)
  const items = array(row.items, (item): OrderItem => {
    const entry = object(item)
    return {
      ordernum: text(entry.ordernum),
      allocationStatus: text(entry.allocationStatus),
      requestedNum: nullableInteger(entry.requestedNum),
      allocatedNum: nullableInteger(entry.allocatedNum),
      expireAt: text(entry.expireAt),
      failureReason: text(entry.failureReason),
    }
  })
  return { items, total: integer(row.total) }
}

export function parseOrderApis(value: unknown): OrderApisResult {
  const row = object(value)
  const records = array(row.records, parseSmsRecord)
  const total = integer(row.total)
  if (total < records.length) throw invalid()
  return {
    ordernum: text(row.ordernum),
    total,
    truncated: bool(row.truncated),
    records,
    allocation: parseAllocation(row.allocation),
  }
}

export function parseFilterApps(value: unknown) {
  const row = object(value)
  const items = array(row.items, (item): FilterAppItem => {
    const entry = object(item)
    return {
      id: integer(entry.id, 1),
      name: text(entry.name),
      price: number(entry.price),
      min: nullableInteger(entry.min),
      max: nullableInteger(entry.max),
    }
  })
  return { items, total: integer(row.total) }
}

export function parseFilterDetail(value: unknown): FilterDetail {
  const row = object(value)
  return {
    orderId: integer(row.orderId, 1),
    ordernum: text(row.ordernum),
    name: text(row.name),
    countryCode: text(row.countryCode),
    country: text(row.country),
    appId: nullableInteger(row.appId),
    price: number(row.price),
    num: nullableInteger(row.num),
    valid: nullableInteger(row.valid),
    money: number(row.money),
    fileUrl: text(row.fileUrl),
    taskFileUrl: text(row.taskFileUrl),
    taskRemark: text(row.taskRemark),
    status: nullableInteger(row.status),
    createTime: text(row.createTime),
    updateTime: text(row.updateTime),
  }
}

export function parseExpiryReminder(value: unknown): ExpiryReminder {
  const row = object(value)
  return {
    tel: text(row.tel),
    expiresAt: text(row.expiresAt),
    checkedAt: nullableText(row.checkedAt),
  }
}

export function parseExpirySnapshot(value: unknown): ExpirySnapshot {
  const row = object(value)
  const items = array(row.items, parseExpiryReminder)
  const pendingTels = array(row.pendingTels, text)
  if (
    items.length > 2000 ||
    pendingTels.length > 8 ||
    new Set(items.map((item) => item.tel)).size !== items.length ||
    new Set(pendingTels).size !== pendingTels.length ||
    items.some(
      (item) =>
        !Number.isFinite(Date.parse(item.expiresAt)) ||
        (item.checkedAt !== null && !Number.isFinite(Date.parse(item.checkedAt))),
    )
  )
    throw invalid()
  return {
    items,
    pendingTels,
    failed: integer(row.failed),
    storageDurable: bool(row.storageDurable),
  }
}

export function parseRenewReport(value: unknown): RenewReport {
  const row = object(value)
  return {
    success: integer(row.success),
    failed: integer(row.failed),
    failedList: array(row.failedList, text),
    total: integer(row.total),
    records: array(row.records, parseSmsRecord),
  }
}
