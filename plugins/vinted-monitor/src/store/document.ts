import { z } from 'zod'

import { unavailable } from '../domain/errors.js'
import { counter, record } from '../domain/sellers.js'
import { AvailabilitySchema } from '../domain/schemas.js'
import type {
  MonitorRecord,
  ProxyRecord,
  RunRecord,
  Seller,
  StoredItem,
} from '../domain/types.js'
import { isVintedHost, stripWww } from '../domain/urls.js'

export interface StoreDocument {
  schemaVersion: 2
  monitors: MonitorRecord[]
  runs: RunRecord[]
  items: StoredItem[]
  sellers: Seller[]
  proxies: ProxyRecord[]
  defaultProxyId: string | null
}

const nullableText = z.string().nullable()
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const runStatus = z.enum(['running', 'success', 'partial', 'failed', 'interrupted'])
const monitorSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  searchUrl: z.string(),
  kind: z.enum(['catalog', 'member']),
  host: z.string(),
  userId: nullableText,
  intervalMinutes: z.number(),
  maxPages: z.number(),
  perPage: z.number(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRunAt: nullableText,
  lastStatus: runStatus.nullable(),
})
const runSchema = z.looseObject({
  id: z.string(),
  monitorId: z.string(),
  monitorName: z.string(),
  status: runStatus,
  startedAt: z.string(),
  finishedAt: nullableText,
  discovered: count,
  inserted: count,
  updated: count,
  skipped: count,
  failed: count,
  truncated: z.boolean(),
  pages: count,
  error: nullableText,
})
const legacyItemSchema = z.looseObject({
  id: z.string(),
  monitorId: z.string(),
  title: z.string(),
  price: z.string(),
  currency: z.string(),
  brand: z.string(),
  size: z.string(),
  condition: z.string(),
  url: z.string(),
  imageUrl: z.string(),
  seller: z.string(),
  listedAt: nullableText,
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
})
const detail = z.record(z.string(), z.unknown())
const sellerSchema = z.looseObject({
  id: z.string(),
  externalId: z.string(),
  domain: z.string(),
  login: nullableText,
  name: nullableText,
  profileUrl: z.string(),
  avatarUrl: nullableText,
  country: nullableText,
  city: nullableText,
  feedbackReputation: z.number().nullable(),
  feedbackCount: count.nullable(),
  followersCount: count.nullable(),
  itemCount: count.nullable(),
  verification: z.record(
    z.string(),
    z.looseObject({
      valid: z.boolean().nullable(),
      available: z.boolean().nullable(),
      verifiedAt: nullableText,
    }),
  ),
  lastLogedOnTs: nullableText,
  updatedOn: nullableText,
  collectedAt: nullableText,
  checkedAt: z.string(),
  error: nullableText,
  detail: detail.nullable(),
})
const associationSchema = z.looseObject({
  monitorId: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
})
const itemSchema = legacyItemSchema.extend({
  externalId: z.string(),
  domain: z.string(),
  monitorIds: z.array(z.string()),
  userId: nullableText,
  sellerProfile: sellerSchema.nullable(),
  images: z.array(z.string()),
  detail,
  favouriteCount: count.nullable(),
  viewCount: count.nullable(),
  starred: z.boolean(),
  availabilityStatus: AvailabilitySchema,
  missingSince: nullableText,
  missingMonitorId: nullableText,
  statusCheckedAt: nullableText,
  statusNote: nullableText,
  collectedAt: z.string(),
  deletedAt: nullableText,
  sourceProxyId: nullableText.default(null),
  associations: z.array(associationSchema),
})
const proxySchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  scheme: z.enum(['http', 'https', 'socks5', 'socks5h']),
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  username: z.string(),
  password: z.string(),
  enabled: z.boolean(),
})
const v1Schema = z.looseObject({
  schemaVersion: z.literal(1),
  monitors: z.array(monitorSchema),
  runs: z.array(runSchema),
  items: z.array(legacyItemSchema),
})
const v2Schema = z.looseObject({
  schemaVersion: z.literal(2),
  monitors: z.array(monitorSchema.extend({ proxyId: nullableText })),
  runs: z.array(
    runSchema.extend({
      userFailed: count,
      scanKey: z.string().optional(),
      seenItemIds: z.array(z.string()).optional(),
    }),
  ),
  items: z.array(itemSchema),
  sellers: z.array(sellerSchema),
  proxies: z.array(proxySchema),
  defaultProxyId: nullableText,
})

export function emptyDocument(): StoreDocument {
  return {
    schemaVersion: 2,
    monitors: [],
    runs: [],
    items: [],
    sellers: [],
    proxies: [],
    defaultProxyId: null,
  }
}

function mergeUnknown(
  first: Record<string, unknown>,
  later: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...later, ...first }
  for (const [key, value] of Object.entries(first)) {
    const left = record(value)
    const right = record(later[key])
    if (left && right)
      Object.defineProperty(merged, key, {
        value: mergeUnknown(left, right),
        writable: true,
        enumerable: true,
        configurable: true,
      })
  }
  return merged
}

function migrate(old: z.infer<typeof v1Schema>): unknown {
  const grouped = new Map<string, z.infer<typeof legacyItemSchema>[]>()
  for (const item of old.items) {
    let domain = ''
    try {
      domain = stripWww(new URL(item.url).hostname)
    } catch {
      /* Try its monitor. */
    }
    if (!isVintedHost(domain))
      domain = stripWww(old.monitors.find((m) => m.id === item.monitorId)?.host ?? '')
    if (!isVintedHost(domain)) throw unavailable('旧商品来源无法识别，原文件已保留')
    const externalId = typeof item.externalId === 'string' ? item.externalId : item.id
    const key = `${domain}:${externalId}`
    const entries = grouped.get(key) ?? []
    entries.push(item)
    grouped.set(key, entries)
  }
  const items = [...grouped.entries()].map(([id, entries]) => {
    entries.sort(
      (a, b) =>
        a.firstSeenAt.localeCompare(b.firstSeenAt) ||
        a.monitorId.localeCompare(b.monitorId),
    )
    const first = entries[0]!
    const [domain = '', externalId = ''] = id.split(':')
    const latest = [...entries].sort(
      (a, b) =>
        b.lastSeenAt.localeCompare(a.lastSeenAt) ||
        b.monitorId.localeCompare(a.monitorId),
    )
    const associations = new Map<string, z.infer<typeof associationSchema>>()
    for (const item of entries) {
      const previous = associations.get(item.monitorId)
      associations.set(item.monitorId, {
        monitorId: item.monitorId,
        firstSeenAt: previous?.firstSeenAt ?? item.firstSeenAt,
        lastSeenAt:
          previous && previous.lastSeenAt > item.lastSeenAt
            ? previous.lastSeenAt
            : item.lastSeenAt,
      })
    }
    return {
      ...entries.reduce<Record<string, unknown>>(mergeUnknown, {}),
      id,
      domain,
      externalId,
      monitorIds: [...associations.keys()],
      associations: [...associations.values()],
      userId: first.userId ?? null,
      sellerProfile: first.sellerProfile ?? null,
      images: first.images ?? (first.imageUrl ? [first.imageUrl] : []),
      detail: first.detail ?? {},
      collectedAt: first.collectedAt ?? first.firstSeenAt,
      lastSeenAt: latest[0]!.lastSeenAt,
      favouriteCount:
        latest.map((i) => counter(i.favouriteCount)).find((v) => v !== null) ?? null,
      viewCount: counter(first.viewCount),
      starred: entries.some((i) => i.starred === true),
      availabilityStatus: first.availabilityStatus ?? 'unknown',
      missingSince: first.missingSince ?? null,
      missingMonitorId: first.missingMonitorId ?? null,
      statusCheckedAt: first.statusCheckedAt ?? null,
      statusNote: first.statusNote ?? null,
      deletedAt: entries.find((i) => typeof i.deletedAt === 'string')?.deletedAt ?? null,
      sourceProxyId: old.monitors.find((m) => m.id === first.monitorId)?.proxyId ?? null,
      // Conflicting unknown values remain recoverable even though the earliest wins.
      legacyRecords: entries,
    }
  })
  return {
    ...old,
    schemaVersion: 2,
    items,
    monitors: old.monitors.map((m) => ({
      ...m,
      host: stripWww(m.host),
      proxyId: m.proxyId ?? null,
    })),
    runs: old.runs.map((r) => ({ ...r, userFailed: r.userFailed ?? 0 })),
    sellers: old.sellers ?? [],
    proxies: old.proxies ?? [],
    defaultProxyId: old.defaultProxyId ?? null,
  }
}

export function parseDocument(text: string): StoreDocument {
  try {
    const raw: unknown = JSON.parse(text)
    const input = record(raw)?.schemaVersion === 1 ? migrate(v1Schema.parse(raw)) : raw
    return v2Schema.parse(input)
  } catch {
    throw unavailable('插件私有存储结构无效或版本不支持，原文件已保留，请先备份并修复')
  }
}
