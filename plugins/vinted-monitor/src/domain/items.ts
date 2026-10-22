import { UpstreamError } from './errors.js'

/** One listing as read from the upstream payload, before it reaches the store. */
export interface DraftItem {
  id: string
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
}

export interface ItemsPage {
  items: DraftItem[]
  /** Entries the payload contained but could not be read; reported as skipped. */
  invalid: number
  hasMore: boolean
}

const MAX_TEXT = 200
const MAX_URL = 2048

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function text(value: unknown, limit = MAX_TEXT): string {
  if (typeof value === 'string') return value.trim().slice(0, limit)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function absoluteUrl(value: unknown): string {
  const candidate = text(value, MAX_URL)
  if (candidate === '') return ''
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

/** `created_at_ts` is unix seconds as a string on some endpoints, a number on others. */
function timestamp(value: unknown): string | null {
  const raw = typeof value === 'number' ? value : Number(text(value))
  if (!Number.isFinite(raw) || raw <= 0) return null
  // Guard against milliseconds sneaking in: anything past year 5138 is bogus.
  const seconds = raw > 1e11 ? Math.floor(raw / 1000) : Math.floor(raw)
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function priceOf(value: unknown): { price: string; currency: string } {
  const price = asRecord(value)
  if (price === null) return { price: text(value, 32), currency: '' }
  return {
    price: text(price.amount, 32),
    currency: text(price.currency_code, 8).toUpperCase(),
  }
}

function draftItem(entry: unknown, itemUrl: (id: string) => string): DraftItem | null {
  const raw = asRecord(entry)
  if (raw === null) return null
  const id = text(raw.id, 64)
  if (id === '' || !/^\d+$/.test(id)) return null
  const money = priceOf(raw.price)
  const photo = asRecord(raw.photo)
  const user = asRecord(raw.user)
  const title = text(raw.title)
  return {
    id,
    title,
    price: money.price,
    currency: money.currency,
    brand: text(raw.brand_title, 80),
    size: text(raw.size_title, 80),
    condition: text(raw.status, 80),
    url: absoluteUrl(raw.url) || itemUrl(id),
    imageUrl: absoluteUrl(photo?.url) || absoluteUrl(photo?.full_size_url),
    seller: text(user?.login, 80),
    listedAt: timestamp(raw.created_at_ts),
  }
}

function hasMore(pagination: unknown, received: number, perPage: number): boolean {
  const page = asRecord(pagination)
  if (page !== null) {
    const totalPages = Number(text(page.total_pages))
    const currentPage = Number(text(page.current_page))
    if (Number.isFinite(totalPages) && Number.isFinite(currentPage)) {
      return currentPage < totalPages
    }
    if (page.next_page !== null && page.next_page !== undefined) return true
  }
  // No pagination block: a full page is the only signal that more may exist.
  return received >= perPage
}

export function parseItemsPage(
  payload: unknown,
  perPage: number,
  itemUrl: (id: string) => string,
): ItemsPage {
  const root = asRecord(payload)
  if (root === null) throw new UpstreamError('invalid-response')
  const list = root.items
  if (!Array.isArray(list)) throw new UpstreamError('invalid-response')
  const items: DraftItem[] = []
  let invalid = 0
  for (const entry of list) {
    const item = draftItem(entry, itemUrl)
    if (item === null) {
      invalid += 1
      continue
    }
    items.push(item)
  }
  return { items, invalid, hasMore: hasMore(root.pagination, list.length, perPage) }
}
