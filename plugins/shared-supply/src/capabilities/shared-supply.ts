import { randomUUID } from 'node:crypto'

import {
  invalidRequest,
  unavailable,
  upstreamFailure,
  UpstreamError,
} from '../domain/errors.js'
import { favoritesCsv, productRecord, type FavoriteRecord } from '../domain/product.js'
import {
  FavoriteAddInputSchema,
  FavoriteRemoveInputSchema,
  ImageSearchInputSchema,
  MAX_IMAGE_BYTES,
  ProductsInputSchema,
  SearchInputSchema,
  StoresInputSchema,
  parseOrThrow,
} from '../domain/schemas.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import {
  CATEGORIES,
  PRODUCT_PAGE_SIZE,
  SEARCH_PAGE_SIZE,
  STORE_PAGE_SIZE,
  type SharedSupplyClient,
} from '../services/upstream.js'
import type { PrivateStore } from '../store/private-store.js'

export const SUPPLY_METHODS = [
  'supply.catalog',
  'supply.stores',
  'supply.products',
  'supply.search',
  'supply.imageSearch',
  'supply.favorites.list',
  'supply.favorites.add',
  'supply.favorites.remove',
  'supply.favorites.csv',
] as const

/** Favourites live in one JSON document; the cap keeps it small and predictable. */
export const MAX_FAVORITES = 500

const MAX_RAW_JSON = 200_000

export interface SharedSupplyOptions {
  client: SharedSupplyClient
  store: PrivateStore
  logger: Logger
  now?: () => Date
  idFactory?: () => string
}

function jpegPayload(base64: string): Buffer {
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.byteLength === 0) throw invalidRequest('图片内容为空')
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw invalidRequest('图片超过 5 MB 上限')
  // Only JPEG is accepted: the upstream image-search endpoint re-encodes nothing.
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    throw invalidRequest('图片搜索只接受 JPEG 数据')
  }
  return buffer
}

/**
 * `supply.catalog` capability: the supplier's public catalogue plus a local
 * favourites list. Nothing here needs a credential.
 */
export class SharedSupply {
  readonly id = 'supply.catalog'
  readonly name = '共享货源'

  private readonly client: SharedSupplyClient
  private readonly store: PrivateStore
  private readonly logger: Logger
  private readonly now: () => Date
  private readonly idFactory: () => string

  constructor(options: SharedSupplyOptions) {
    this.client = options.client
    this.store = options.store
    this.logger = options.logger
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? randomUUID
  }

  status(): Record<string, unknown> {
    return { storage: this.store.kind, storageDurable: this.store.durable }
  }

  async call(context: DispatchContext): Promise<unknown> {
    switch (context.method) {
      case 'supply.catalog':
        context.assertAlive()
        return { categories: CATEGORIES.map((item) => ({ ...item })) }
      case 'supply.stores':
        return await this.stores(context)
      case 'supply.products':
        return await this.products(context)
      case 'supply.search':
        return await this.search(context)
      case 'supply.imageSearch':
        return await this.imageSearch(context)
      case 'supply.favorites.list':
        return await this.listFavorites(context)
      case 'supply.favorites.add':
        return await this.addFavorite(context)
      case 'supply.favorites.remove':
        return await this.removeFavorite(context)
      case 'supply.favorites.csv':
        return await this.exportCsv(context)
      default:
        throw invalidRequest('插件不支持该方法')
    }
  }

  private async stores(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(StoresInputSchema, context.payload)
    const items = await this.request(() => this.client.stores(input.typeId, input.page))
    context.assertAlive()
    return {
      items,
      page: input.page,
      pageSize: STORE_PAGE_SIZE,
      hasMore: items.length >= STORE_PAGE_SIZE,
    }
  }

  private async products(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(ProductsInputSchema, context.payload)
    const items = await this.request(() =>
      this.client.products(input.merchantId, input.page),
    )
    context.assertAlive()
    return {
      items,
      page: input.page,
      pageSize: PRODUCT_PAGE_SIZE,
      hasMore: items.length >= PRODUCT_PAGE_SIZE,
    }
  }

  private async search(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(SearchInputSchema, context.payload)
    const items = await this.request(() => this.client.search(input.keyword, input.page))
    context.assertAlive()
    return {
      items,
      page: input.page,
      pageSize: SEARCH_PAGE_SIZE,
      hasMore: items.length >= SEARCH_PAGE_SIZE,
    }
  }

  private async imageSearch(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(ImageSearchInputSchema, context.payload)
    const jpeg = jpegPayload(input.data)
    const items = await this.request(() => this.client.imageSearch(jpeg))
    context.assertAlive()
    return { items }
  }

  private async listFavorites(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const document = await this.store.read()
    context.assertAlive()
    return {
      items: document.favorites,
      total: document.favorites.length,
      storageDurable: this.store.durable,
    }
  }

  private async addFavorite(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(FavoriteAddInputSchema, context.payload)
    const raw = JSON.stringify(input.product)
    if (raw.length > MAX_RAW_JSON) {
      throw invalidRequest('商品数据过大，无法收藏')
    }
    const record = productRecord(input.product)
    if (record.id === '' || record.id.length > 64 || record.title === '') {
      throw invalidRequest('商品缺少标识或标题，无法收藏')
    }
    const savedAt = this.now().toISOString()
    return await this.store.mutate((document) => {
      const existing = document.favorites.find((item) => item.id === record.id)
      if (existing === undefined && document.favorites.length >= MAX_FAVORITES) {
        throw invalidRequest(`收藏上限为 ${MAX_FAVORITES} 件，请先删除部分收藏`)
      }
      if (existing === undefined) {
        const item: FavoriteRecord = {
          ...record,
          favoriteId: this.idFactory(),
          savedAt,
        }
        // Newest first, matching how the page lists them.
        document.favorites.unshift(item)
        return { item, alreadySaved: false, total: document.favorites.length }
      }
      // Re-saving refreshes the snapshot but keeps the original save time.
      const refreshed: FavoriteRecord = {
        ...record,
        favoriteId: existing.favoriteId,
        savedAt: existing.savedAt,
      }
      const index = document.favorites.indexOf(existing)
      document.favorites[index] = refreshed
      return { item: refreshed, alreadySaved: true, total: document.favorites.length }
    })
  }

  private async removeFavorite(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(FavoriteRemoveInputSchema, context.payload)
    return await this.store.mutate((document) => {
      const before = document.favorites.length
      document.favorites = document.favorites.filter(
        (item) => item.favoriteId !== input.favoriteId,
      )
      return {
        favoriteId: input.favoriteId,
        removed: document.favorites.length < before,
        total: document.favorites.length,
      }
    })
  }

  private async exportCsv(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const document = await this.store.read()
    return { text: favoritesCsv(document.favorites), count: document.favorites.length }
  }

  /** Turns upstream failures into the shared RPC error vocabulary. */
  private async request<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof UpstreamError) {
        this.logger.warn(`共享货源上游失败：${error.reason}`)
        throw upstreamFailure(error)
      }
      if (error instanceof Error) {
        throw unavailable('共享货源请求失败', error)
      }
      throw unavailable('共享货源请求失败')
    }
  }
}
