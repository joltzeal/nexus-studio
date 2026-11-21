import type {
  SupplyCategory,
  SupplyFavorite,
  SupplyMerchant,
  SupplyPageResult,
  SupplyProduct,
} from './model'

export class SharedSupplyResponseError extends Error {
  constructor() {
    super('共享货源插件返回的数据无效，请刷新或更新插件后重试。')
    this.name = 'SharedSupplyResponseError'
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SharedSupplyResponseError()
  }
  return value as Record<string, unknown>
}

function text(value: unknown, max = 100_000): string {
  if (typeof value !== 'string' || value.length > max)
    throw new SharedSupplyResponseError()
  return value
}

function nonEmpty(value: unknown, max = 256): string {
  const result = text(value, max)
  if (result.trim() === '') throw new SharedSupplyResponseError()
  return result
}

function imageUrl(value: string, merchant = false): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.port === '' &&
      ((url.hostname === 'product.aliyizhan.com' &&
        (url.pathname.startsWith('/person/') || url.pathname.startsWith('/upload-file/'))) ||
        (merchant && url.hostname === 'thirdwx.qlogo.cn' && url.pathname.startsWith('/mmopen/'))) &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

export function parseSupplyCategory(value: unknown): SupplyCategory {
  const row = object(value)
  return { id: nonEmpty(row.id), name: nonEmpty(row.name) }
}

export function parseSupplyMerchant(value: unknown): SupplyMerchant {
  const row = object(value)
  const iconUrl = text(row.iconUrl, 2048)
  if (iconUrl !== '' && !imageUrl(iconUrl, true)) {
    throw new SharedSupplyResponseError()
  }
  return {
    id: text(row.id),
    uid: nonEmpty(row.uid, 64),
    nickName: text(row.nickName, 512),
    iconUrl,
    floor: text(row.floor, 512),
    houseNumber: text(row.houseNumber, 512),
  }
}

export function parseSupplyProduct(value: unknown): SupplyProduct {
  const row = object(value)
  if (!Array.isArray(row.images)) throw new SharedSupplyResponseError()
  const images = row.images.map((image) => {
    const url = text(image, 2048)
    if (!imageUrl(url)) throw new SharedSupplyResponseError()
    return url
  })
  const coverUrl = text(row.coverUrl, 2048)
  if (coverUrl !== (images[0] ?? '')) throw new SharedSupplyResponseError()
  const publishedAt = row.publishedAt
  if (
    publishedAt !== null &&
    (typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt)))
  ) {
    throw new SharedSupplyResponseError()
  }
  return {
    id: nonEmpty(row.id, 128),
    title: text(row.title, 2048),
    description: text(row.description, 100_000),
    price: text(row.price, 256),
    merchantId: text(row.merchantId, 128),
    images,
    coverUrl,
    publishedAt,
    raw: object(row.raw),
  }
}

export function parseSupplyFavorite(value: unknown): SupplyFavorite {
  const row = object(value)
  const product = parseSupplyProduct(row)
  const savedAt = nonEmpty(row.savedAt, 64)
  if (Number.isNaN(Date.parse(savedAt))) throw new SharedSupplyResponseError()
  return {
    ...product,
    favoriteId: nonEmpty(row.favoriteId, 64),
    savedAt,
  }
}

function parseSupplyPage<T extends { id: string }>(
  value: unknown,
  requestedPage: number,
  pageSize: number,
  parseItem: (item: unknown) => T,
  identity: (item: T) => string = (item) => item.id,
): SupplyPageResult<T> {
  const row = object(value)
  if (
    !Array.isArray(row.items) ||
    row.items.length > pageSize ||
    row.page !== requestedPage ||
    row.pageSize !== pageSize ||
    typeof row.hasMore !== 'boolean'
  ) {
    throw new SharedSupplyResponseError()
  }
  const items = row.items.map(parseItem)
  const ids = items.map(identity)
  if (new Set(ids).size !== ids.length) throw new SharedSupplyResponseError()
  return { items, page: requestedPage, pageSize, hasMore: row.hasMore }
}

export function parseSupplyCatalog(value: unknown): { categories: SupplyCategory[] } {
  const row = object(value)
  if (!Array.isArray(row.categories) || row.categories.length > 100) {
    throw new SharedSupplyResponseError()
  }
  const categories = row.categories.map(parseSupplyCategory)
  if (
    categories.length === 0 ||
    new Set(categories.map((category) => category.id)).size !== categories.length
  ) {
    throw new SharedSupplyResponseError()
  }
  return { categories }
}

export function parseSupplyStorePage(value: unknown, page: number) {
  return parseSupplyPage(value, page, 80, parseSupplyMerchant, (merchant) => merchant.uid)
}

export function parseSupplyProductList(value: unknown, page: number) {
  return parseSupplyPage(value, page, 30, parseSupplyProduct)
}

export function parseSupplySearchPage(value: unknown, page: number) {
  return parseSupplyPage(value, page, 15, parseSupplyProduct)
}

export function parseSupplyImageSearch(value: unknown): { items: SupplyProduct[] } {
  const row = object(value)
  if (!Array.isArray(row.items) || row.items.length > 100) {
    throw new SharedSupplyResponseError()
  }
  const items = row.items.map(parseSupplyProduct)
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new SharedSupplyResponseError()
  }
  return { items }
}

export function parseSupplyFavorites(value: unknown) {
  const row = object(value)
  if (
    !Array.isArray(row.items) ||
    !Number.isSafeInteger(row.total) ||
    row.total !== row.items.length ||
    typeof row.storageDurable !== 'boolean'
  ) {
    throw new SharedSupplyResponseError()
  }
  const items = row.items.map(parseSupplyFavorite)
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    new Set(items.map((item) => item.favoriteId)).size !== items.length
  ) {
    throw new SharedSupplyResponseError()
  }
  return { items, total: row.total as number, storageDurable: row.storageDurable }
}

export function parseSupplyFavoriteAdd(value: unknown) {
  const row = object(value)
  if (typeof row.alreadySaved !== 'boolean' || !Number.isSafeInteger(row.total)) {
    throw new SharedSupplyResponseError()
  }
  return {
    item: parseSupplyFavorite(row.item),
    alreadySaved: row.alreadySaved,
    total: row.total as number,
  }
}

export function parseSupplyFavoriteRemove(value: unknown, favoriteId: string) {
  const row = object(value)
  if (
    row.favoriteId !== favoriteId ||
    typeof row.removed !== 'boolean' ||
    !Number.isSafeInteger(row.total)
  ) {
    throw new SharedSupplyResponseError()
  }
  return { favoriteId, removed: row.removed, total: row.total as number }
}

export function parseSupplyFavoritesCsv(value: unknown) {
  const row = object(value)
  if (typeof row.text !== 'string' || row.text.length > 2 * 1024 * 1024) {
    throw new SharedSupplyResponseError()
  }
  if (
    !Number.isSafeInteger(row.count) ||
    (row.count as number) < 0 ||
    (row.count as number) > 500
  ) {
    throw new SharedSupplyResponseError()
  }
  return { text: row.text, count: row.count as number }
}
