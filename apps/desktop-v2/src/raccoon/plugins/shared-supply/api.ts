import { callPlugin } from '../call'
import {
  SHARED_SUPPLY_CAPABILITY,
  SHARED_SUPPLY_PLUGIN_ID,
  type SupplyFavorite,
  type SupplyMerchant,
  type SupplyPageResult,
  type SupplyProduct,
} from './model'
import {
  parseSupplyCatalog,
  parseSupplyFavoriteAdd,
  parseSupplyFavoriteRemove,
  parseSupplyFavorites,
  parseSupplyFavoritesCsv,
  parseSupplyImageSearch,
  parseSupplyProductList,
  parseSupplySearchPage,
  parseSupplyStorePage,
} from './parse'

const LOOKUP_DEADLINE = 40_000

export type SupplyRpc = <T>(
  method: string,
  payload: unknown,
  parse: (value: unknown) => T,
  deadlineMs?: number,
) => Promise<T>

const defaultRpc: SupplyRpc = (method, payload, parse, deadlineMs = 30_000) =>
  callPlugin(
    SHARED_SUPPLY_PLUGIN_ID,
    SHARED_SUPPLY_CAPABILITY,
    method,
    payload,
    parse,
    deadlineMs,
  )

export function createSharedSupplyApi(rpc: SupplyRpc = defaultRpc) {
  const request = <T>(
    method: string,
    payload: unknown,
    parse: (value: unknown) => T,
    deadlineMs?: number,
  ) => rpc(method, payload, parse, deadlineMs)

  return {
    catalog: () => request('supply.catalog', {}, parseSupplyCatalog),
    stores: (typeId: string, page: number): Promise<SupplyPageResult<SupplyMerchant>> =>
      request(
        'supply.stores',
        { typeId, page },
        (value) => parseSupplyStorePage(value, page),
        LOOKUP_DEADLINE,
      ),
    products: (
      merchantId: string,
      page: number,
    ): Promise<SupplyPageResult<SupplyProduct>> =>
      request(
        'supply.products',
        { merchantId, page },
        (value) => parseSupplyProductList(value, page),
        LOOKUP_DEADLINE,
      ),
    search: (keyword: string, page: number): Promise<SupplyPageResult<SupplyProduct>> =>
      request(
        'supply.search',
        { keyword, page },
        (value) => parseSupplySearchPage(value, page),
        LOOKUP_DEADLINE,
      ),
    imageSearch: (data: string) =>
      request(
        'supply.imageSearch',
        { data, mime: 'image/jpeg' },
        parseSupplyImageSearch,
        LOOKUP_DEADLINE,
      ),
    favorites: () => request('supply.favorites.list', {}, parseSupplyFavorites),
    addFavorite: (product: SupplyProduct) =>
      request('supply.favorites.add', { product: product.raw }, parseSupplyFavoriteAdd),
    removeFavorite: (favoriteId: string) =>
      request('supply.favorites.remove', { favoriteId }, (value) =>
        parseSupplyFavoriteRemove(value, favoriteId),
      ),
    favoritesCsv: () => request('supply.favorites.csv', {}, parseSupplyFavoritesCsv),
    image: {
      open: <T>(payload: unknown, parse: (value: unknown) => T) =>
        request('supply.image.open', payload, parse, LOOKUP_DEADLINE),
      read: <T>(payload: unknown, parse: (value: unknown) => T) =>
        request('supply.image.read', payload, parse, LOOKUP_DEADLINE),
      close: <T>(payload: unknown, parse: (value: unknown) => T) =>
        request('supply.image.close', payload, parse, LOOKUP_DEADLINE),
    },
  }
}

export const sharedSupplyApi = createSharedSupplyApi()
export const sharedSupplyRpc = defaultRpc

export type SharedSupplyApi = ReturnType<typeof createSharedSupplyApi>

export function productLabel(product: Pick<SupplyProduct, 'title' | 'id'>): string {
  return product.title.trim() === '' ? `未命名商品 · ${product.id}` : product.title
}

export type SupplyFavoriteResult = SupplyFavorite
export { SHARED_SUPPLY_CAPABILITY, SHARED_SUPPLY_PLUGIN_ID }
