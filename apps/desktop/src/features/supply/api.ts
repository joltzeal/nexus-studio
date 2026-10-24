import { callPlugin } from '@/lib/platform/native-plugins'
import {
  SUPPLY_CAPABILITY,
  SUPPLY_PLUGIN_ID,
  type CatalogResult,
  type Favorite,
  type FavoritesResult,
  type Merchant,
  type Paged,
  type Product,
} from './types'

function call<T>(method: string, payload: unknown = {}, deadlineMs?: number): Promise<T> {
  return callPlugin<T>(SUPPLY_PLUGIN_ID, SUPPLY_CAPABILITY, method, payload, deadlineMs)
}

/** Catalogue calls go through a third-party service; the host default is too tight. */
const LOOKUP_DEADLINE = 40_000

export function getCatalog(): Promise<CatalogResult> {
  return call<CatalogResult>('supply.catalog')
}

export function listStores(typeId: string, page: number): Promise<Paged<Merchant>> {
  return call<Paged<Merchant>>('supply.stores', { typeId, page }, LOOKUP_DEADLINE)
}

export function listProducts(merchantId: string, page: number): Promise<Paged<Product>> {
  return call<Paged<Product>>('supply.products', { merchantId, page }, LOOKUP_DEADLINE)
}

export function searchProducts(keyword: string, page: number): Promise<Paged<Product>> {
  return call<Paged<Product>>('supply.search', { keyword, page }, LOOKUP_DEADLINE)
}

export function imageSearch(jpegBase64: string): Promise<{ items: Product[] }> {
  return call<{ items: Product[] }>(
    'supply.imageSearch',
    { data: jpegBase64, mime: 'image/jpeg' },
    LOOKUP_DEADLINE,
  )
}

export function listFavorites(): Promise<FavoritesResult> {
  return call<FavoritesResult>('supply.favorites.list')
}

export function addFavorite(product: Product): Promise<{
  item: Favorite
  alreadySaved: boolean
  total: number
}> {
  return call('supply.favorites.add', { product: product.raw })
}

export function removeFavorite(favoriteId: string): Promise<{
  favoriteId: string
  removed: boolean
  total: number
}> {
  return call('supply.favorites.remove', { favoriteId })
}

export function favoritesCsv(): Promise<{ text: string; count: number }> {
  return call('supply.favorites.csv')
}

const IMAGE_MAX_BYTES = 8 * 1024 * 1024
const IMAGE_MAX_CHUNK = 256 * 1024
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const TRANSFER_ERROR = '图片传输数据无效，请刷新或更新共享货源插件'

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error(TRANSFER_ERROR)
  return value as Record<string, unknown>
}

function imageError(cause: unknown): Error {
  const text =
    typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : ''
  if (text === TRANSFER_ERROR) return new Error(text)
  if (/未声明该方法|不支持该方法/.test(text)) {
    return new Error('请更新共享货源插件后重试图片加载')
  }
  if (/不支持的货源图片地址|跳转/.test(text)) {
    return new Error('图片地址或跳转不在支持的来源范围内')
  }
  if (/TIMEOUT|超时/.test(text)) return new Error('图片加载超时，请检查应用代理后重试')
  if (/RATE_LIMITED|频繁|缓存已满|请求较多/.test(text))
    return new Error('图片请求较多，请稍后重试')
  if (/超过.*上限/.test(text)) return new Error('图片超过 8 MiB 上限')
  if (/类型|格式|内容/.test(text)) return new Error('图片内容或格式不受支持')
  return new Error('图片加载失败，请检查网络和应用代理后重试')
}

/** Only IPC crosses the WebView boundary; no remote URL is fetched by the page. */
export async function loadSupplyImage(url: string, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted()
  let id: string | null = null
  try {
    const meta = record(
      await call<unknown>('supply.image.open', { url }, LOOKUP_DEADLINE),
    )
    if (typeof meta.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(meta.id)) {
      throw new Error(TRANSFER_ERROR)
    }
    id = meta.id
    signal.throwIfAborted()
    const { size, chunkSize, mime } = meta
    if (
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > IMAGE_MAX_BYTES ||
      typeof chunkSize !== 'number' ||
      !Number.isSafeInteger(chunkSize) ||
      chunkSize <= 0 ||
      chunkSize > IMAGE_MAX_CHUNK ||
      typeof mime !== 'string' ||
      !IMAGE_MIMES.has(mime)
    ) {
      throw new Error(TRANSFER_ERROR)
    }
    const bytes = new Uint8Array(size)
    for (let offset = 0; offset < size; offset += chunkSize) {
      signal.throwIfAborted()
      const chunk = record(await call<unknown>('supply.image.read', { id, offset }))
      signal.throwIfAborted()
      const expected = Math.min(chunkSize, size - offset)
      if (
        chunk.offset !== offset ||
        typeof chunk.data !== 'string' ||
        chunk.data.length !== Math.ceil(expected / 3) * 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.data)
      ) {
        throw new Error(TRANSFER_ERROR)
      }
      const decoded = atob(chunk.data)
      if (decoded.length !== expected || btoa(decoded) !== chunk.data)
        throw new Error(TRANSFER_ERROR)
      for (let i = 0; i < decoded.length; i += 1)
        bytes[offset + i] = decoded.charCodeAt(i)
    }
    return new Blob([bytes], { type: mime })
  } catch (cause) {
    if (signal.aborted) signal.throwIfAborted()
    throw imageError(cause)
  } finally {
    if (id !== null) {
      // A stopped plugin can reject cleanup; its process exit / 60 s expiry also
      // releases the snapshot. Cleanup must not hide a successful download.
      await call('supply.image.close', { id }).catch(() => undefined)
    }
  }
}
