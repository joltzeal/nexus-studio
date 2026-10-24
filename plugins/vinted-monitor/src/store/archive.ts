import { invalidRequest } from '../domain/errors.js'
import type { DraftItem } from '../domain/items.js'
import type { ItemsListInput } from '../domain/schemas.js'
import { sellerRecord } from '../domain/sellers.js'
import type {
  ItemRecord,
  ItemSummary,
  MonitorRecord,
  RunRecord,
  Seller,
  SellerSummary,
  StoredItem,
} from '../domain/types.js'
import type { StoreDocument } from './document.js'

export function requireItem(document: StoreDocument, id: string): StoredItem {
  const item = document.items.find((i) => i.id === id && i.deletedAt === null)
  if (!item) throw invalidRequest('商品不存在或已删除')
  return item
}

export function itemView(document: StoreDocument, item: StoredItem): ItemRecord {
  return {
    ...itemSummaryView(document, item),
    images: item.images,
    detail: item.detail,
    sellerProfile: itemSeller(document, item),
  }
}

function itemSeller(document: StoreDocument, item: StoredItem): Seller | null {
  return (
    document.sellers.find(
      (seller) => seller.domain === item.domain && seller.externalId === item.userId,
    ) ?? item.sellerProfile
  )
}

function sellerSummary(seller: Seller | null): SellerSummary | null {
  if (seller === null) return null
  return {
    id: seller.id,
    externalId: seller.externalId,
    domain: seller.domain,
    login: seller.login,
    name: seller.name,
    profileUrl: seller.profileUrl,
    avatarUrl: seller.avatarUrl,
    country: seller.country,
    city: seller.city,
    feedbackReputation: seller.feedbackReputation,
    feedbackCount: seller.feedbackCount,
    followersCount: seller.followersCount,
    itemCount: seller.itemCount,
    verification: seller.verification,
    lastLogedOnTs: seller.lastLogedOnTs,
    updatedOn: seller.updatedOn,
    collectedAt: seller.collectedAt,
    checkedAt: seller.checkedAt,
    error: seller.error,
  }
}

function itemSummaryView(document: StoreDocument, item: StoredItem): ItemSummary {
  // Explicit public fields prevent stored credentials or future private metadata leaking.
  return {
    id: item.id,
    externalId: item.externalId,
    domain: item.domain,
    monitorId: item.monitorId,
    monitorIds: item.monitorIds,
    title: item.title,
    price: item.price,
    currency: item.currency,
    brand: item.brand,
    size: item.size,
    condition: item.condition,
    url: item.url,
    imageUrl: item.imageUrl,
    seller: item.seller,
    userId: item.userId,
    sellerProfile: sellerSummary(itemSeller(document, item)),
    favouriteCount: item.favouriteCount,
    viewCount: item.viewCount,
    starred: item.starred,
    availabilityStatus: item.availabilityStatus,
    missingSince: item.missingSince,
    missingMonitorId: item.missingMonitorId,
    statusCheckedAt: item.statusCheckedAt,
    statusNote: item.statusNote,
    collectedAt: item.collectedAt,
    listedAt: item.listedAt,
    firstSeenAt: item.firstSeenAt,
    lastSeenAt: item.lastSeenAt,
  }
}

export function applyItems(
  document: StoreDocument,
  monitor: MonitorRecord,
  drafts: DraftItem[],
  now: string,
) {
  let inserted = 0
  let updated = 0
  let skipped = 0
  const users = new Set<string>()
  const existing = new Map(document.items.map((i) => [i.id, i]))
  for (const draft of drafts) {
    const id = `${monitor.host}:${draft.id}`
    let item = existing.get(id)
    if (item?.deletedAt) {
      skipped++
      continue
    }
    if (item) {
      if (now >= item.lastSeenAt) {
        if (draft.favouriteCount !== null && draft.favouriteCount !== undefined)
          item.favouriteCount = draft.favouriteCount
        item.lastSeenAt = now
        if (item.availabilityStatus === 'pending') {
          item.availabilityStatus = 'available'
          item.missingSince = null
          item.missingMonitorId = null
        }
      }
      updated++
    } else {
      item = {
        ...draft,
        id,
        externalId: draft.id,
        domain: monitor.host,
        monitorId: monitor.id,
        monitorIds: [],
        associations: [],
        userId: draft.userId ?? null,
        sellerProfile: null,
        images: draft.images ?? (draft.imageUrl ? [draft.imageUrl] : []),
        detail: draft.detail ?? {},
        favouriteCount: draft.favouriteCount ?? null,
        viewCount: draft.viewCount ?? null,
        starred: false,
        availabilityStatus: 'unknown',
        missingSince: null,
        missingMonitorId: null,
        statusCheckedAt: null,
        statusNote: null,
        collectedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
        deletedAt: null,
        sourceProxyId: monitor.proxyId,
      }
      document.items.push(item)
      existing.set(id, item)
      inserted++
    }
    const association = item.associations.find((a) => a.monitorId === monitor.id)
    if (association) {
      if (now > association.lastSeenAt) association.lastSeenAt = now
    } else {
      item.associations.push({ monitorId: monitor.id, firstSeenAt: now, lastSeenAt: now })
      item.monitorIds.push(monitor.id)
    }
    if (item.userId !== null) {
      let seller = document.sellers.find(
        (s) => s.domain === item.domain && s.externalId === item.userId,
      )
      if (!seller) {
        seller = sellerRecord(item.domain, item.userId, now, null, '等待获取卖家资料')
        document.sellers.push(seller)
      }
      if (seller.collectedAt === null) users.add(item.userId)
      else seller.error = null
    }
  }
  return { inserted, updated, skipped, users: [...users] }
}

export function scanKey(monitor: MonitorRecord): string {
  return JSON.stringify([monitor.searchUrl, monitor.maxPages, monitor.perPage])
}

export function markMissing(
  document: StoreDocument,
  current: RunRecord,
  now: string,
): void {
  if (
    current.status !== 'success' ||
    current.failed ||
    current.userFailed ||
    current.truncated ||
    current.error ||
    !current.scanKey ||
    !current.seenItemIds
  )
    return
  const previous = document.runs
    .filter(
      (run) =>
        run.id !== current.id &&
        run.monitorId === current.monitorId &&
        run.startedAt < current.startedAt &&
        run.status === 'success' &&
        run.failed === 0 &&
        run.userFailed === 0 &&
        !run.truncated &&
        !run.error &&
        run.scanKey === current.scanKey &&
        run.seenItemIds !== undefined,
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
  if (!previous?.seenItemIds) return
  const before = new Set(previous.seenItemIds)
  const seen = new Set(current.seenItemIds)
  for (const item of document.items) {
    if (
      item.deletedAt ||
      !before.has(item.id) ||
      seen.has(item.id) ||
      !item.monitorIds.includes(current.monitorId) ||
      ['pending', 'sold', 'ignored'].includes(item.availabilityStatus) ||
      item.associations.some((a) => a.lastSeenAt >= current.startedAt) ||
      (item.statusCheckedAt !== null && item.statusCheckedAt >= current.startedAt)
    )
      continue
    item.availabilityStatus = 'pending'
    item.missingSince = now
    item.missingMonitorId = current.monitorId
    item.statusCheckedAt = null
    item.statusNote = null
  }
}

export function paginate<T>(rows: T[], page: number, pageSize: number) {
  return {
    items: rows.slice(page * pageSize, (page + 1) * pageSize),
    total: rows.length,
    page,
    pageSize,
    totalPages: Math.ceil(rows.length / pageSize),
  }
}

function favouriteMatches(value: number | null, input: ItemsListInput): boolean {
  const op = input.favouriteCountOp
  if (op === 'isNull') return value === null
  if (op === 'notNull') return value !== null
  if (op === 'between') {
    if (input.favouriteCountStart === undefined && input.favouriteCountEnd === undefined)
      return true
    return (
      value !== null &&
      (input.favouriteCountStart === undefined || value >= input.favouriteCountStart) &&
      (input.favouriteCountEnd === undefined || value <= input.favouriteCountEnd)
    )
  }
  if (input.favouriteCount === undefined) return true
  if (value === null) return false
  const target = input.favouriteCount
  return op === 'eq'
    ? value === target
    : op === 'ne'
      ? value !== target
      : op === 'gt'
        ? value > target
        : op === 'ge'
          ? value >= target
          : op === 'lt'
            ? value < target
            : value <= target
}

export function queryItems(document: StoreDocument, input: ItemsListInput) {
  const keyword = (input.keyword ?? '').toLowerCase()
  const rows = document.items
    .filter(
      (i) =>
        i.deletedAt === null &&
        (input.monitorId === undefined || i.monitorIds.includes(input.monitorId)) &&
        (input.externalId === undefined || i.externalId === input.externalId) &&
        (input.starred === undefined || i.starred === input.starred) &&
        (input.availabilityStatus === undefined ||
          i.availabilityStatus === input.availabilityStatus) &&
        favouriteMatches(i.favouriteCount, input) &&
        (!keyword ||
          [i.title, i.brand, i.seller, i.externalId].some((s) =>
            s.toLowerCase().includes(keyword),
          )),
    )
    .sort((a, b) => {
      if (input.order !== 'collected_desc' && a.favouriteCount !== b.favouriteCount) {
        if (a.favouriteCount === null) return 1
        if (b.favouriteCount === null) return -1
        return input.order === 'favourite_asc'
          ? a.favouriteCount - b.favouriteCount
          : b.favouriteCount - a.favouriteCount
      }
      return b.collectedAt.localeCompare(a.collectedAt) || b.id.localeCompare(a.id)
    })
  const page = paginate(rows, input.page, input.pageSize)
  return { ...page, items: page.items.map((i) => itemSummaryView(document, i)) }
}
