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
