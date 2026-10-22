import { invalidRequest } from './errors.js'

/**
 * Vinted runs one storefront per country, each on its own hostname. The list is
 * explicit on purpose: a monitor may only point at a host we know how to build
 * an API request for.
 */
export const VINTED_DOMAINS: readonly string[] = [
  'vinted.com',
  'vinted.co.uk',
  'vinted.at',
  'vinted.be',
  'vinted.cz',
  'vinted.de',
  'vinted.dk',
  'vinted.ee',
  'vinted.es',
  'vinted.fi',
  'vinted.fr',
  'vinted.gr',
  'vinted.hr',
  'vinted.hu',
  'vinted.ie',
  'vinted.it',
  'vinted.lt',
  'vinted.lv',
  'vinted.nl',
  'vinted.pl',
  'vinted.pt',
  'vinted.ro',
  'vinted.se',
  'vinted.si',
  'vinted.sk',
]

const KNOWN_HOSTS = new Set(VINTED_DOMAINS)

export type MonitorKind = 'catalog' | 'member'

export interface MonitorTarget {
  readonly kind: MonitorKind
  /** Hostname without `www.`, e.g. `vinted.fr`. */
  readonly host: string
  /** Wardrobe owner for `member` targets, otherwise null. */
  readonly userId: string | null
  /** Canonical, human-readable URL; this is what gets stored and shown. */
  readonly url: string
  /** Filter parameters kept for `catalog` targets, in their original order. */
  readonly filters: readonly (readonly [string, string])[]
}

/**
 * Filter keys the collector knows how to forward. Anything else is rejected
 * instead of silently dropped, because a monitor that ignores half of its own
 * URL would report items the user never asked for.
 */
const FILTER_KEYS = new Set([
  'search_text',
  'catalog[]',
  'brand_ids[]',
  'color_ids[]',
  'size_ids[]',
  'status_ids[]',
  'material_ids[]',
  'video_game_platform_ids[]',
  'price_from',
  'price_to',
  'currency',
])

/** A catalog URL must narrow the result somehow, or it is just the homepage. */
const SELECTOR_KEYS = ['search_text', 'catalog[]', 'brand_ids[]']

const MEMBER_PATH = /^\/member\/(\d+)(?:-[^/]*)?\/?$/
const CATALOG_PATH = /^\/(?:[a-z-]+\/)?catalog\/?$/

export function stripWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '')
}

export function isVintedHost(hostname: string): boolean {
  return KNOWN_HOSTS.has(stripWww(hostname))
}

function normalizeHost(hostname: string): string {
  const host = stripWww(hostname)
  if (!KNOWN_HOSTS.has(host)) {
    throw invalidRequest('监控 URL 需要指向 Vinted 站点的域名')
  }
  return host
}

/**
 * Turns a pasted Vinted URL into the canonical form the collector uses.
 *
 * Two shapes are supported: a `/catalog` search page (filters preserved, newest
 * first forced) and a `/member/<id>` wardrobe (filters dropped, because the
 * wardrobe endpoint takes none).
 */
export function normalizeMonitorUrl(input: string): MonitorTarget {
  const text = input.trim()
  if (text === '') throw invalidRequest('监控 URL 不能为空')
  if (text.length > 2048) throw invalidRequest('监控 URL 过长')

  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw invalidRequest('监控 URL 不是有效的地址')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw invalidRequest('监控 URL 需要使用 http 或 https')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw invalidRequest('监控 URL 不能包含账号或口令')
  }

  const host = normalizeHost(parsed.hostname)
  const path = parsed.pathname === '' ? '/' : parsed.pathname

  const member = MEMBER_PATH.exec(path)
  if (member !== null) {
    const userId = member[1] ?? ''
    return {
      kind: 'member',
      host,
      userId,
      url: `https://${host}/member/${userId}`,
      filters: [],
    }
  }

  if (!CATALOG_PATH.test(path)) {
    throw invalidRequest(
      '只支持 /catalog 搜索页与 /member/<id> 衣柜页；其他页面没有对应的采集接口',
    )
  }

  const filters: [string, string][] = []
  for (const [key, value] of parsed.searchParams) {
    if (key === 'order') continue
    if (!FILTER_KEYS.has(key)) {
      throw invalidRequest(`监控 URL 包含不支持的筛选参数：${key}`)
    }
    if (value.trim() === '') continue
    filters.push([key, value])
  }

  const selector = filters.find(([key]) => SELECTOR_KEYS.includes(key))
  if (selector === undefined) {
    throw invalidRequest('搜索页需要至少一个 search_text、catalog[] 或 brand_ids[] 条件')
  }

  const query = new URLSearchParams()
  for (const [key, value] of filters) query.append(key, value)
  query.append('order', 'newest_first')

  return {
    kind: 'catalog',
    host,
    userId: null,
    url: `https://${host}${path.replace(/\/$/, '')}?${query.toString()}`,
    filters,
  }
}

/** Catalogue search endpoint; the filters are re-applied to the API call. */
export function catalogueRequest(
  target: MonitorTarget,
  page: number,
  perPage: number,
): string {
  const query = new URLSearchParams()
  for (const [key, value] of target.filters) query.append(key, value)
  query.set('page', String(page))
  query.set('per_page', String(perPage))
  query.set('order', 'newest_first')
  return `https://api.${target.host}/svc-catalogue/items?${query.toString()}`
}

/** Wardrobe endpoint; it pages only, so no filter is forwarded. */
export function wardrobeRequest(
  target: MonitorTarget,
  page: number,
  perPage: number,
): string {
  const userId = target.userId ?? ''
  const query = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
  })
  return `https://${target.host}/api/v2/wardrobe/${userId}/items?${query.toString()}`
}

export function itemRequestUrl(
  target: MonitorTarget,
  page: number,
  perPage: number,
): string {
  return target.kind === 'member'
    ? wardrobeRequest(target, page, perPage)
    : catalogueRequest(target, page, perPage)
}

/** Absolute listing URL used for the "打开商品" action. */
export function itemPageUrl(target: MonitorTarget, itemId: string): string {
  return `https://${target.host}/items/${itemId}`
}
