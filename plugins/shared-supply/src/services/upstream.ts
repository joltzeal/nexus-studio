import { createCipheriv, createDecipheriv } from 'node:crypto'

import { UpstreamError } from '../domain/errors.js'
import {
  merchantRecord,
  productRecord,
  type CategoryRecord,
  type MerchantRecord,
  type ProductRecord,
} from '../domain/product.js'

export const CATALOGUE_ORIGIN = 'https://gz.aliyizhan.com'
export const IMAGE_SEARCH_URL =
  'https://aliyizhan.com/personProduct/getImgSearchResult.action'

/**
 * Fixed protocol constant of the supplier's public mobile client, not a user
 * credential: it ships inside that app and grants nothing on its own. It is
 * required to encode the request body and is therefore not a secret slot.
 */
const PROTOCOL_KEY = Buffer.from('wxtdefgabcdawn12', 'utf8')
const ALGORITHM = 'aes-128-ecb'

const HEADERS = {
  'User-Agent': 'shandongMarket/5.4.7 (iPhone; iOS 16.4.1; Scale/2.00)',
  'Content-Type': 'application/wxt;charset=UTF-8',
}
const IMAGE_USER_AGENT = 'shandongMarket/5.4.7 (iPhone; iOS 16.4.1; Scale/2.00)'

const CATALOGUE_TIMEOUT_MS = 25_000
const IMAGE_TIMEOUT_MS = 30_000
const CATALOGUE_MAX_BYTES = 4 * 1024 * 1024
const IMAGE_MAX_BYTES = 8 * 1024 * 1024

/** Page sizes are the upstream's own; the page cannot ask for more. */
export const STORE_PAGE_SIZE = 80
export const PRODUCT_PAGE_SIZE = 30
export const SEARCH_PAGE_SIZE = 15

export const CATEGORIES: readonly CategoryRecord[] = [
  { id: '1', name: '母婴' },
  { id: '4', name: '鞋靴' },
  { id: '7', name: '箱包' },
  { id: '16', name: '百货' },
  { id: '30', name: '数码' },
  { id: '29', name: '美妆' },
  { id: '26', name: '皮带' },
  { id: '28', name: '配饰' },
  { id: '27', name: '手表' },
  { id: '5', name: '潮服' },
]

export const CATEGORY_IDS: readonly string[] = CATEGORIES.map((item) => item.id)

/**
 * The supplier's client escapes non-ASCII before encrypting. Node would emit
 * raw UTF-8, which is also valid JSON, but keeping the exact byte layout of the
 * reference implementation avoids depending on that leniency.
 */
function ensureAscii(json: string): string {
  return json.replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

export function encodeBody(payload: Record<string, unknown>): string {
  const json = ensureAscii(JSON.stringify(payload))
  const cipher = createCipheriv(ALGORITHM, PROTOCOL_KEY, null)
  return Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]).toString('base64')
}

export function decodeBody(base64: string): unknown {
  const decipher = createDecipheriv(ALGORITHM, PROTOCOL_KEY, null)
  const plain = Buffer.concat([
    decipher.update(Buffer.from(base64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
  return JSON.parse(plain)
}

function reasonForStatus(status: number): UpstreamError {
  if (status === 429) return new UpstreamError('rate-limit')
  if (status === 408 || status === 504) return new UpstreamError('timeout')
  if (status >= 500) return new UpstreamError('unavailable')
  return new UpstreamError('upstream-network')
}

async function readCapped(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) {
    throw new UpstreamError('invalid-response', '响应体超过大小上限')
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > limit) {
    throw new UpstreamError('invalid-response', '响应体超过大小上限')
  }
  return buffer
}

function rowsOf(payload: unknown): Record<string, unknown>[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new UpstreamError('invalid-response')
  }
  const envelope = payload as Record<string, unknown>
  if (envelope['success'] !== true || !Array.isArray(envelope['data'])) {
    const message = typeof envelope['msg'] === 'string' ? envelope['msg'] : null
    throw new UpstreamError('upstream-refused', message)
  }
  return envelope['data'].filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
  )
}

export interface SharedSupplyClientOptions {
  fetchImpl?: typeof fetch
}

/**
 * Adapter for the supplier's public catalogue endpoints. Everything the plugin
 * knows about that protocol lives in this file.
 */
export class SharedSupplyClient {
  private readonly fetchImpl: typeof fetch

  constructor(options: SharedSupplyClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async encrypted(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const body = encodeBody(payload)
    let response: Response
    try {
      response = await this.fetchImpl(`${CATALOGUE_ORIGIN}${path}?marketCode=gz`, {
        method: 'POST',
        headers: HEADERS,
        body,
        signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
      })
    } catch (error) {
      throw networkError(error)
    }
    if (!response.ok) throw reasonForStatus(response.status)
    const raw = await readCapped(response, CATALOGUE_MAX_BYTES)
    let decoded: unknown
    try {
      decoded = decodeBody(raw.toString('utf8'))
    } catch {
      throw new UpstreamError('invalid-response', '响应无法解密或不是 JSON')
    }
    return rowsOf(decoded)
  }

  async stores(typeId: string, page: number): Promise<MerchantRecord[]> {
    const rows = await this.encrypted('/market/getMarketArchivesMouthsV2.action', {
      pageSize: STORE_PAGE_SIZE,
      typeId,
      pageIndex: page,
    })
    return rows.map(merchantRecord)
  }

  async products(merchantId: string, page: number): Promise<ProductRecord[]> {
    const rows = await this.encrypted('/personProduct/getPersonProductByType.action', {
      pageIndex: page,
      pageSize: PRODUCT_PAGE_SIZE,
      uid: merchantId,
      type: 1,
    })
    return rows.map(productRecord)
  }

  async search(keyword: string, page: number): Promise<ProductRecord[]> {
    const rows = await this.encrypted('/market/getMarketFriendsTimeLineV2.action', {
      pageSize: SEARCH_PAGE_SIZE,
      categoryId: [],
      mediaType: 0,
      pageIndex: page,
      minPrice: '0',
      typeId: '',
      sourceType: 0,
      assure: 0,
      keyWord: keyword,
      sort: [
        { sortOrder: 1, sortType: 3 },
        { sortOrder: 0, sortType: 0 },
      ],
      maxPrice: '100000',
    })
    return rows.map(productRecord)
  }

  /** Image search is plain multipart, not the encrypted catalogue protocol. */
  async imageSearch(jpeg: Buffer): Promise<ProductRecord[]> {
    const form = new FormData()
    form.append('index', '0')
    form.append(
      'file',
      new Blob([Uint8Array.from(jpeg)], { type: 'image/jpeg' }),
      'search.jpg',
    )
    let response: Response
    try {
      response = await this.fetchImpl(IMAGE_SEARCH_URL, {
        method: 'POST',
        headers: { 'User-Agent': IMAGE_USER_AGENT },
        body: form,
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      })
    } catch (error) {
      throw networkError(error)
    }
    if (!response.ok) throw reasonForStatus(response.status)
    const raw = await readCapped(response, IMAGE_MAX_BYTES)
    let decoded: unknown
    try {
      decoded = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new UpstreamError('invalid-response', '以图搜索响应不是 JSON')
    }
    return rowsOf(decoded).map(productRecord)
  }
}

function networkError(error: unknown): UpstreamError {
  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return new UpstreamError('timeout')
  }
  return new UpstreamError('upstream-network')
}
