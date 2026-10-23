export const SUPPLY_PLUGIN_ID = 'studio.shared-supply'
export const SUPPLY_CAPABILITY = 'supply.catalog'

/** Page sizes are fixed by the supplier's own endpoints. */
export const STORE_PAGE_SIZE = 80
export const PRODUCT_PAGE_SIZE = 30
export const SEARCH_PAGE_SIZE = 15

export interface Category {
  id: string
  name: string
}

export interface Merchant {
  id: string
  uid: string
  nickName: string
  iconUrl: string
  floor: string
  houseNumber: string
}

export interface Product {
  id: string
  title: string
  description: string
  price: string
  merchantId: string
  images: string[]
  coverUrl: string
  publishedAt: string | null
  raw: Record<string, unknown>
}

export interface Favorite extends Product {
  favoriteId: string
  savedAt: string
}

export interface Paged<T> {
  items: T[]
  page: number
  pageSize: number
  hasMore: boolean
}

export interface CatalogResult {
  categories: Category[]
}

export interface FavoritesResult {
  items: Favorite[]
  total: number
  storageDurable: boolean
}

/** Tauri rejects with the command's `Err(String)`, which is not an `Error`. */
export function message(error: unknown): string {
  return typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '请求失败，请稍后重试'
}

export function merchantTitle(merchant: Merchant): string {
  return merchant.nickName.trim() === '' ? '未命名商户' : merchant.nickName
}

export function merchantLocation(merchant: Merchant): string {
  return [merchant.floor, merchant.houseNumber]
    .filter((part) => part.trim() !== '')
    .join(' · ')
}

export function publishedText(product: Product): string {
  if (product.publishedAt === null) return '发布时间未知'
  const date = new Date(product.publishedAt)
  if (Number.isNaN(date.getTime())) return '发布时间未知'
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** Everything a user would paste into a listing, in reading order. */
export function productText(product: Product): string {
  const lines = [
    product.title,
    `价格：${product.price === '' ? '未标注' : product.price}`,
  ]
  if (product.description !== '') lines.push('', product.description)
  if (product.images.length > 0) lines.push('', ...product.images)
  return lines.join('\n')
}
