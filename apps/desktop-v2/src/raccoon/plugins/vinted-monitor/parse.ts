import type {
  AvailabilityStatus,
  Item,
  ItemSummary,
  Monitor,
  MonitorList,
  MonitorProxy,
  Page,
  ProxyList,
  Run,
  UrlInspection,
} from './model.ts'

const invalid = () => new Error('Vinted 监控插件返回的数据格式无效，请更新插件后重试。')

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw invalid()
  return value
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value)
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid()
  return value
}

function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw invalid()
  return value
}

function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value)
}

function nullableNumber(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid()
  return value
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalid()
  return value.map(text)
}

function record(value: unknown): Record<string, unknown> {
  return object(value)
}

function availability(value: unknown): AvailabilityStatus {
  if (
    value === 'unknown' ||
    value === 'pending' ||
    value === 'available' ||
    value === 'sold' ||
    value === 'ignored'
  )
    return value
  throw invalid()
}

function runStatus(value: unknown): Run['status'] {
  if (
    value === 'running' ||
    value === 'success' ||
    value === 'partial' ||
    value === 'failed' ||
    value === 'interrupted'
  )
    return value
  throw invalid()
}

function parseSeller(
  value: unknown,
  summary: boolean,
): ItemSummary['sellerProfile'] | Item['sellerProfile'] {
  if (value === null) return null
  const row = object(value)
  const verification = object(row.verification)
  const parsedVerification: NonNullable<ItemSummary['sellerProfile']>['verification'] = {}
  for (const [key, value] of Object.entries(verification)) {
    const check = object(value)
    parsedVerification[key] = {
      valid: check.valid === null ? null : bool(check.valid),
      available: check.available === null ? null : bool(check.available),
      verifiedAt: nullableText(check.verifiedAt),
    }
  }
  const seller = {
    id: text(row.id),
    externalId: text(row.externalId),
    domain: text(row.domain),
    login: nullableText(row.login),
    name: nullableText(row.name),
    profileUrl: text(row.profileUrl),
    avatarUrl: nullableText(row.avatarUrl),
    country: nullableText(row.country),
    city: nullableText(row.city),
    feedbackReputation: nullableNumber(row.feedbackReputation),
    feedbackCount: nullableInteger(row.feedbackCount),
    followersCount: nullableInteger(row.followersCount),
    itemCount: nullableInteger(row.itemCount),
    verification: parsedVerification,
    lastLogedOnTs: nullableText(row.lastLogedOnTs),
    updatedOn: nullableText(row.updatedOn),
    collectedAt: nullableText(row.collectedAt),
    checkedAt: text(row.checkedAt),
    error: nullableText(row.error),
  }
  return summary
    ? seller
    : { ...seller, detail: row.detail === null ? null : record(row.detail) }
}

export function parseItemSummary(value: unknown): ItemSummary {
  const row = object(value)
  const item = {
    id: text(row.id),
    externalId: text(row.externalId),
    domain: text(row.domain),
    monitorId: text(row.monitorId),
    monitorIds: stringArray(row.monitorIds),
    title: text(row.title),
    price: text(row.price),
    currency: text(row.currency),
    brand: text(row.brand),
    size: text(row.size),
    condition: text(row.condition),
    url: text(row.url),
    imageUrl: text(row.imageUrl),
    seller: text(row.seller),
    userId: nullableText(row.userId),
    sellerProfile: parseSeller(row.sellerProfile, true),
    favouriteCount: nullableInteger(row.favouriteCount),
    viewCount: nullableInteger(row.viewCount),
    starred: bool(row.starred),
    availabilityStatus: availability(row.availabilityStatus),
    missingSince: nullableText(row.missingSince),
    missingMonitorId: nullableText(row.missingMonitorId),
    statusCheckedAt: nullableText(row.statusCheckedAt),
    statusNote: nullableText(row.statusNote),
    collectedAt: text(row.collectedAt),
    listedAt: nullableText(row.listedAt),
    firstSeenAt: text(row.firstSeenAt),
    lastSeenAt: text(row.lastSeenAt),
  }
  if (
    !/^.+:\d{1,32}$/.test(item.id) ||
    !/^\d{1,32}$/.test(item.externalId) ||
    item.id !== `${item.domain}:${item.externalId}`
  )
    throw invalid()
  return item
}

export function parseItem(value: unknown): Item {
  const row = object(value)
  const summary = parseItemSummary(row)
  const images = stringArray(row.images)
  return {
    ...summary,
    sellerProfile: parseSeller(row.sellerProfile, false) as Item['sellerProfile'],
    images,
    detail: record(row.detail),
  }
}

export function parseItemPage(value: unknown): Page<ItemSummary> {
  const row = object(value)
  if (!Array.isArray(row.items)) throw invalid()
  const page = integer(row.page)
  const pageSize = integer(row.pageSize, 1)
  const total = integer(row.total)
  const totalPages = integer(row.totalPages)
  if (pageSize > 100 || totalPages !== Math.ceil(total / pageSize)) throw invalid()
  const items = row.items.map(parseItemSummary)
  if (items.length > pageSize || (items.length > 0 && page >= totalPages)) throw invalid()
  return { items, page, pageSize, total, totalPages }
}

export function parseMonitor(value: unknown): Monitor {
  const row = object(value)
  const kind = row.kind
  if (kind !== 'catalog' && kind !== 'member') throw invalid()
  const status = row.lastStatus === null ? null : runStatus(row.lastStatus)
  const monitor: Monitor = {
    id: text(row.id),
    name: text(row.name),
    searchUrl: text(row.searchUrl),
    kind,
    host: text(row.host),
    userId: nullableText(row.userId),
    proxyId: nullableText(row.proxyId),
    intervalMinutes: integer(row.intervalMinutes, 1),
    maxPages: integer(row.maxPages, 1),
    perPage: integer(row.perPage, 1),
    enabled: bool(row.enabled),
    createdAt: text(row.createdAt),
    updatedAt: text(row.updatedAt),
    lastRunAt: nullableText(row.lastRunAt),
    lastStatus: status,
  }
  if (monitor.intervalMinutes > 1440 || monitor.maxPages > 20 || monitor.perPage > 96)
    throw invalid()
  return monitor
}

export function parseMonitorList(value: unknown): MonitorList {
  const row = object(value)
  if (!Array.isArray(row.items)) throw invalid()
  const itemCounts = object(row.itemCounts)
  const counts: Record<string, number> = {}
  for (const [key, value] of Object.entries(itemCounts)) counts[key] = integer(value)
  return {
    items: row.items.map(parseMonitor),
    total: integer(row.total),
    itemCounts: counts,
    storageDurable: bool(row.storageDurable),
  }
}

export function parseRun(value: unknown): Run {
  const row = object(value)
  return {
    id: text(row.id),
    monitorId: text(row.monitorId),
    monitorName: text(row.monitorName),
    status: runStatus(row.status),
    startedAt: text(row.startedAt),
    finishedAt: nullableText(row.finishedAt),
    discovered: integer(row.discovered),
    inserted: integer(row.inserted),
    updated: integer(row.updated),
    userFailed: integer(row.userFailed),
    skipped: integer(row.skipped),
    failed: integer(row.failed),
    truncated: bool(row.truncated),
    pages: integer(row.pages),
    error: nullableText(row.error),
  }
}

export function parseRunPage(value: unknown): Page<Run> {
  const row = object(value)
  if (!Array.isArray(row.items)) throw invalid()
  const page = integer(row.page)
  const pageSize = integer(row.pageSize, 1)
  const total = integer(row.total)
  const totalPages = integer(row.totalPages)
  if (
    pageSize > 100 ||
    totalPages !== Math.ceil(total / pageSize) ||
    row.items.length > pageSize
  )
    throw invalid()
  return { items: row.items.map(parseRun), page, pageSize, total, totalPages }
}

export function parseProxy(value: unknown): MonitorProxy {
  const row = object(value)
  if (
    row.scheme !== 'http' &&
    row.scheme !== 'https' &&
    row.scheme !== 'socks5' &&
    row.scheme !== 'socks5h'
  )
    throw invalid()
  return {
    id: text(row.id),
    name: text(row.name),
    scheme: row.scheme,
    host: text(row.host),
    port: integer(row.port, 1),
    username: text(row.username),
    hasPassword: bool(row.hasPassword),
    enabled: bool(row.enabled),
  }
}

export function parseProxyList(value: unknown): ProxyList {
  const row = object(value)
  if (!Array.isArray(row.items)) throw invalid()
  const defaultProxyId = nullableText(row.defaultProxyId)
  const items = row.items.map(parseProxy)
  if (defaultProxyId !== null && !items.some(({ id }) => id === defaultProxyId))
    throw invalid()
  return { items, defaultProxyId, storageDurable: bool(row.storageDurable) }
}

export function parseUrlInspection(value: unknown): UrlInspection {
  const row = object(value)
  if (row.kind !== 'catalog' && row.kind !== 'member') throw invalid()
  const host = text(row.host)
  const userId = nullableText(row.userId)
  const url = text(row.url)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw invalid()
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.hostname !== host ||
    !/^vinted\./.test(host)
  )
    throw invalid()
  if (row.kind === 'member') {
    const member = parsed.pathname.match(/^\/member\/(\d+)(?:-|$)/)
    if (!member || member[1] !== userId) throw invalid()
  } else if (userId !== null || !parsed.pathname.startsWith('/catalog')) throw invalid()
  return { kind: row.kind, host, userId, url }
}

export function parseObject(value: unknown): Record<string, unknown> {
  return object(value)
}
export function parseText(value: unknown): string {
  return text(value)
}
export function parseBoolean(value: unknown): boolean {
  return bool(value)
}
export function parseNullableText(value: unknown): string | null {
  return nullableText(value)
}
export function parseRunResult(value: unknown): { run: Run } {
  return { run: parseRun(object(value).run) }
}
export function parseMonitorResult(value: unknown): { item: Monitor; created: boolean } {
  const row = object(value)
  return { item: parseMonitor(row.item), created: bool(row.created) }
}
export function parseItemResult(value: unknown): { item: Item } {
  return { item: parseItem(object(value).item) }
}
export function parseStarResult(value: unknown): { item: ItemSummary } {
  const row = object(value)
  return { item: parseItemSummary(row.item) }
}
export function parseProxyResult(value: unknown): {
  item: MonitorProxy
  created: boolean
} {
  const row = object(value)
  return { item: parseProxy(row.item), created: bool(row.created) }
}
export function parseRemoveResult(value: unknown): { removed: boolean } {
  const row = object(value)
  return { removed: bool(row.removed) }
}
export function parseDefaultProxyResult(value: unknown): {
  defaultProxyId: string | null
} {
  const row = object(value)
  return { defaultProxyId: nullableText(row.defaultProxyId) }
}
export function parseUrlResult(value: unknown): UrlInspection {
  return parseUrlInspection(object(value))
}
