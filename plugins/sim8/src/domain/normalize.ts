import type {
  AllocationState,
  AppItem,
  CategoryItem,
  FilterAppItem,
  FilterDetail,
  OrderItem,
  PrefixReport,
  ProfileInfo,
  PurchasedApi,
} from './types.js'

/**
 * The specification leaves several item shapes open (`items: {}`, `url_list:
 * []`), and the live service has answered with both strings and objects for the
 * same field. Every payload therefore goes through these readers instead of a
 * cast: a wrong assumption becomes an empty list, never a crash mid-order.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function pick(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

export function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

export function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * Numbers arrive as `+8613800138000`, `8613800138000` or with spaces. The key
 * has to be stable, because it is what decides whether a purchase replaces a
 * record or adds one.
 */
export function normalizeTel(value: unknown): string {
  const raw = text(value).replace(/[\s()-]/g, '')
  const plus = raw.startsWith('+') ? '+' : ''
  const digits = raw.replace(/\D/g, '')
  return digits === '' ? '' : `${plus}${digits}`
}

/** The record URL carries its own token as a query parameter. */
export function tokenFromUrl(url: string): string {
  try {
    return new URL(url).searchParams.get('token') ?? ''
  } catch {
    return ''
  }
}

export function normalizeProfile(value: unknown): ProfileInfo {
  const source = asRecord(value) ?? {}
  return {
    username: text(source['username']),
    nickname: text(source['nickname']),
    avatar: text(source['avatar']),
    money: num(source['money']) ?? 0,
  }
}

export function normalizeCategories(value: unknown): {
  items: CategoryItem[]
  total: number
} {
  const source = asRecord(value) ?? {}
  const items: CategoryItem[] = []
  for (const entry of asArray(source['list'])) {
    const row = asRecord(entry)
    if (row === null) continue
    const id = num(pick(row, ['id', 'cate_id']))
    if (id === null) continue
    items.push({
      id,
      name: text(pick(row, ['name', 'title'])) || `分类 ${String(id)}`,
      count: num(pick(row, ['count', 'total', 'num'])),
    })
  }
  return { items, total: num(source['total']) ?? items.length }
}

export function normalizeApps(value: unknown): { items: AppItem[]; total: number } {
  const source = asRecord(value) ?? {}
  const items: AppItem[] = []
  for (const entry of asArray(source['list'])) {
    const row = asRecord(entry)
    if (row === null) continue
    const id = num(pick(row, ['id', 'app_id']))
    if (id === null) continue
    items.push({
      id,
      cateId: num(pick(row, ['cate_id'])),
      name: text(pick(row, ['name', 'title'])) || `项目 ${String(id)}`,
      price: num(pick(row, ['price', 'money'])) ?? 0,
      stock: num(pick(row, ['num', 'stock', 'number'])),
    })
  }
  return { items, total: num(source['total']) ?? items.length }
}

export function normalizePrefixes(value: unknown): PrefixReport {
  const source = asRecord(value) ?? {}
  const items: PrefixReport['items'] = []
  for (const entry of asArray(source['list'])) {
    const row = asRecord(entry)
    if (row === null) continue
    const prefix = text(pick(row, ['prefix', 'name']))
    if (prefix === '') continue
    items.push({ prefix, num: num(pick(row, ['num', 'count'])) ?? 0 })
  }
  return {
    items,
    count: num(source['count']) ?? items.length,
    num: num(source['num']) ?? items.reduce((sum, item) => sum + item.num, 0),
  }
}

/**
 * One number row. `ordernum` is absent from `buy/create`'s list entries, so the
 * caller passes the order number it just received.
 */
function purchasedFromRecord(
  row: Record<string, unknown>,
  ordernum: string,
): PurchasedApi | null {
  const tel = normalizeTel(pick(row, ['tel', 'phone', 'number']))
  if (tel === '') return null
  const api = text(pick(row, ['api', 'url', 'link']))
  const token = text(pick(row, ['token'])) || tokenFromUrl(api)
  return {
    tel,
    token,
    api,
    apiId: num(pick(row, ['id', 'api_id'])),
    ordernum: text(pick(row, ['ordernum'])) || ordernum,
    appId: num(pick(row, ['app_id'])),
    cateId: num(pick(row, ['cate_id'])),
    type: num(pick(row, ['type'])),
    endTime: text(pick(row, ['end_time', 'endTime', 'expire_at'])),
    remark: text(pick(row, ['remark', 'note'])),
    status: num(pick(row, ['status'])),
    renew: num(pick(row, ['renew'])),
    smsCount: num(pick(row, ['sms_count'])),
    voiceCount: num(pick(row, ['voice_count'])),
  }
}

/**
 * `url_list` is documented as untyped and has appeared as `+tel----url` lines.
 * Those lines carry the number and the link but nothing else, which is enough
 * to read a code from.
 */
function purchasedFromLine(line: string, ordernum: string): PurchasedApi | null {
  const match = /^([+\d][\d\s()-]*?)\s*-{2,}\s*(https?:\/\/\S+)$/.exec(line.trim())
  if (match === null) return null
  const tel = normalizeTel(match[1])
  const api = match[2]
  if (tel === '' || api === undefined) return null
  return {
    tel,
    token: tokenFromUrl(api),
    api,
    apiId: null,
    ordernum,
    appId: null,
    cateId: null,
    type: null,
    endTime: '',
    remark: '',
    status: null,
    renew: null,
    smsCount: null,
    voiceCount: null,
  }
}

/**
 * Reads every number the answer mentions, from `list`, `url_list` or a single
 * `data` object, and de-duplicates by number so a payload that reports both
 * does not produce two rows.
 */
export function normalizePurchased(value: unknown, ordernum = ''): PurchasedApi[] {
  const source = asRecord(value) ?? {}
  // The caller knows the order number it asked about; the payload often does
  // too. Either one is enough to keep the rows attributable.
  const order = ordernum !== '' ? ordernum : text(pick(source, ['ordernum', 'order_num']))
  const found = new Map<string, PurchasedApi>()

  const add = (item: PurchasedApi | null): void => {
    if (item === null) return
    const existing = found.get(item.tel)
    // A full row beats a line that only had a number and a link.
    if (existing === undefined || (existing.apiId === null && item.apiId !== null)) {
      found.set(item.tel, item)
      return
    }
    // Keep the fields the richer row already has.
    found.set(item.tel, {
      ...existing,
      api: existing.api === '' ? item.api : existing.api,
      token: existing.token === '' ? item.token : existing.token,
    })
  }

  for (const entry of asArray(source['list'])) {
    const row = asRecord(entry)
    if (row !== null) add(purchasedFromRecord(row, order))
  }
  for (const entry of asArray(source['url_list'])) {
    if (typeof entry === 'string') {
      add(purchasedFromLine(entry, order))
      continue
    }
    const row = asRecord(entry)
    if (row !== null) add(purchasedFromRecord(row, order))
  }
  const single = asRecord(source['data'])
  if (single !== null) add(purchasedFromRecord(single, order))
  // `changeToken` answers with the record itself at the root, not under `data`.
  else if (normalizeTel(source['tel']) !== '') add(purchasedFromRecord(source, order))

  return [...found.values()]
}

export function normalizeOrders(value: unknown): { items: OrderItem[]; total: number } {
  const source = asRecord(value) ?? {}
  const items: OrderItem[] = []
  for (const entry of asArray(source['list'])) {
    const row = asRecord(entry)
    if (row === null) continue
    items.push({
      ordernum: text(pick(row, ['ordernum', 'order_num'])),
      allocationStatus: text(pick(row, ['allocation_status'])),
      requestedNum: num(pick(row, ['requested_num'])),
      allocatedNum: num(pick(row, ['allocated_num'])),
      expireAt: text(pick(row, ['expire_at'])),
      failureReason: text(pick(row, ['failure_reason'])),
    })
  }
  return { items, total: num(source['total']) ?? items.length }
}

export function normalizeAllocation(value: unknown, ordernum = ''): AllocationState {
  const source = asRecord(value) ?? {}
  return {
    ordernum: text(pick(source, ['ordernum'])) || ordernum,
    allocationStatus: text(pick(source, ['allocation_status'])),
    requestedNum: num(pick(source, ['requested_num'])),
    allocatedNum: num(pick(source, ['allocated_num'])),
    apiCount: num(pick(source, ['api_count'])),
    expireAt: text(pick(source, ['expire_at'])),
    failureReason: text(pick(source, ['failure_reason'])),
  }
}

export function normalizeFilterApps(value: unknown): {
  items: FilterAppItem[]
  total: number
} {
  const source = asRecord(value) ?? {}
  const items: FilterAppItem[] = []
  for (const entry of asArray(source['list'])) {
    const row = asRecord(entry)
    if (row === null) continue
    const id = num(pick(row, ['id', 'app_id']))
    if (id === null) continue
    items.push({
      id,
      name: text(pick(row, ['name', 'title'])) || `项目 ${String(id)}`,
      price: num(pick(row, ['price'])) ?? 0,
      min: num(pick(row, ['number_min'])),
      max: num(pick(row, ['number_max'])),
    })
  }
  return { items, total: num(source['total']) ?? items.length }
}

export function normalizeFilterDetail(value: unknown): FilterDetail {
  const source = asRecord(value) ?? {}
  return {
    orderId: num(pick(source, ['order_id'])) ?? 0,
    ordernum: text(pick(source, ['ordernum'])),
    name: text(pick(source, ['name'])),
    countryCode: text(pick(source, ['code'])),
    country: text(pick(source, ['country'])),
    appId: num(pick(source, ['app_id'])),
    price: num(pick(source, ['price'])) ?? 0,
    num: num(pick(source, ['num'])),
    valid: num(pick(source, ['valid'])),
    money: num(pick(source, ['money'])) ?? 0,
    fileUrl: text(pick(source, ['file_url'])),
    taskFileUrl: text(pick(source, ['task_file_url'])),
    taskRemark: text(pick(source, ['task_remark'])),
    status: num(pick(source, ['status'])),
    createTime: text(pick(source, ['create_time'])),
    updateTime: text(pick(source, ['update_time'])),
  }
}
