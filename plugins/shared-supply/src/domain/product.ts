/**
 * Normalisation of the supplier's raw payloads. Everything the page sees goes
 * through here, so an unexpected shape degrades to an empty field instead of
 * leaking through into the UI.
 */

import { IMAGE_HOST, IMAGE_PATH_PREFIX, supplyImageUrl } from './image-url.js'

export { IMAGE_HOST, IMAGE_PATH_PREFIX } from './image-url.js'

/** Earliest and latest plausible publish timestamps (2000-01-01 .. 2100-01-01). */
const MIN_TIMESTAMP = 946_684_800
const MAX_TIMESTAMP = 4_102_444_800

export interface ProductRecord {
  id: string
  title: string
  description: string
  price: string
  merchantId: string
  images: string[]
  coverUrl: string
  publishedAt: string | null
  /** Untouched upstream object; kept for favourites so nothing is lost. */
  raw: Record<string, unknown>
}

export interface MerchantRecord {
  id: string
  uid: string
  nickName: string
  iconUrl: string
  floor: string
  houseNumber: string
}

export interface CategoryRecord {
  id: string
  name: string
}

export interface FavoriteRecord extends ProductRecord {
  /** Local identifier; the upstream product id stays in `id`. */
  favoriteId: string
  savedAt: string
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * Only images served from the supplier's own product host are accepted: a
 * payload could otherwise point the page at an arbitrary URL.
 */
export function imageUrls(product: Record<string, unknown>): string[] {
  const pics = product['pics']
  if (typeof pics !== 'object' || pics === null) return []
  const holder = pics as Record<string, unknown>
  const values = holder['picList'] ?? holder['videoThumb']
  if (!Array.isArray(values)) return []
  const urls: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const url = supplyImageUrl(value)
    if (url === null) continue
    const parsed = new URL(url)
    if (parsed.hostname !== IMAGE_HOST) continue
    if (!parsed.pathname.startsWith(IMAGE_PATH_PREFIX)) continue
    if (!urls.includes(url)) urls.push(url)
  }
  return urls
}

/** `createdTime` is either seconds or milliseconds; anything else is unknown. */
export function publishedAt(product: Record<string, unknown>): string | null {
  const created = product['createdTime']
  if (typeof created !== 'number' && typeof created !== 'string') return null
  let timestamp = Number(created)
  if (!Number.isFinite(timestamp)) return null
  if (timestamp > 10_000_000_000) timestamp /= 1000
  if (timestamp < MIN_TIMESTAMP || timestamp > MAX_TIMESTAMP) return null
  return new Date(timestamp * 1000).toISOString()
}

export function productRecord(product: Record<string, unknown>): ProductRecord {
  const images = imageUrls(product)
  return {
    id: text(product['id']),
    title: text(product['title']),
    description: text(product['description']),
    price: text(product['price']),
    merchantId: text(product['uid']) || text(product['holder']),
    images,
    coverUrl: images[0] ?? '',
    publishedAt: publishedAt(product),
    raw: product,
  }
}

export function merchantRecord(merchant: Record<string, unknown>): MerchantRecord {
  return {
    id: text(merchant['id']),
    uid: text(merchant['uid']),
    nickName: text(merchant['nickName']),
    iconUrl: supplyImageUrl(merchant['iconUrl']) ?? '',
    floor: text(merchant['floor']),
    houseNumber: text(merchant['houseNumber']),
  }
}

/** Favourites keep the original payload so a future step can reuse it. */
export function favoriteRecord(
  product: Record<string, unknown>,
  savedAt: string,
  favoriteId: string,
): FavoriteRecord {
  return { ...productRecord(product), favoriteId, savedAt }
}

function cell(value: string): string {
  // A leading =, +, - or @ makes a spreadsheet treat the text as a formula.
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return `"${guarded.replaceAll('"', '""')}"`
}

export const FAVORITE_CSV_HEADER = [
  '商品标题',
  '价格',
  '商户',
  '图片数',
  '封面',
  '发布时间',
  '收藏时间',
] as const

/** CRLF plus a BOM so Excel opens the Chinese headers correctly. */
export function favoritesCsv(rows: readonly FavoriteRecord[]): string {
  const lines = [FAVORITE_CSV_HEADER.map(cell).join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.title,
        row.price,
        row.merchantId,
        String(row.images.length),
        row.coverUrl,
        row.publishedAt ?? '',
        row.savedAt,
      ]
        .map(cell)
        .join(','),
    )
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}
