import { randomUUID } from 'node:crypto'
import {
  invalidRequest,
  isPluginFailure,
  rateLimited,
  timedOut,
  unavailable,
} from '../domain/errors.js'
import { imageUrls } from '../domain/sellers.js'
import { vintedImageUrl } from '../domain/image-urls.js'
import type { ItemRecord } from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import { readBody } from './body.js'

const MAX_BYTES = 8 * 1024 * 1024
const CHUNK_BYTES = 262144
const MAX_TRANSFER_BYTES = 32 * 1024 * 1024
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

function imageMime(bytes: Buffer): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png'
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  return null
}

export class VintedImages {
  private readonly transfers = new Map<
    string,
    { bytes: Buffer; timer: ReturnType<typeof setTimeout> }
  >()
  private transferBytes = 0
  private downloading = 0

  async open(
    item: ItemRecord,
    value: string,
    fetchImpl: typeof fetch,
    context: DispatchContext,
  ) {
    const initialUrl = vintedImageUrl(value)
    const owned = [
      item.imageUrl,
      ...item.images,
      ...imageUrls(item.detail),
      item.sellerProfile?.avatarUrl,
      ...imageUrls(item.sellerProfile?.detail ?? {}),
    ]
      .filter((v): v is string => typeof v === 'string')
      .map(vintedImageUrl)
    if (initialUrl === null || !owned.includes(initialUrl))
      throw invalidRequest('图片不属于该归档商品或卖家，或不在允许的 Vinted CDN 内')
    let url: string = initialUrl
    context.assertAlive()
    if (this.downloading >= 4 || this.transfers.size + this.downloading >= 8)
      throw rateLimited('图片请求较多，请稍后重试')
    this.downloading++
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(20_000, context.deadlineAt - Date.now())),
    )
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        context.assertAlive()
        const response = await fetchImpl(url, {
          signal: controller.signal,
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: { Accept: 'image/jpeg, image/png, image/webp, image/gif' },
        })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel()
          const location = response.headers.get('location')
          const next: string | null =
            location === null ? null : vintedImageUrl(new URL(location, url).href)
          if (next === null || redirects === 3)
            throw unavailable('图片跳转地址不在允许范围内')
          url = next
          continue
        }
        const declared = (response.headers.get('content-type') ?? '')
          .split(';')[0]!
          .trim()
          .toLowerCase()
        if (
          !response.ok ||
          (!MIME_TYPES.has(declared) && declared !== 'application/octet-stream')
        ) {
          await response.body?.cancel()
          throw unavailable('图片服务不可用或返回了不支持的内容类型')
        }
        const bytes = await readBody(response, MAX_BYTES, controller.signal)
        const mime = imageMime(bytes)
        if (
          mime === null ||
          (declared !== mime && declared !== 'application/octet-stream')
        )
          throw unavailable('图片内容与类型不符')
        context.assertAlive()
        if (this.transferBytes + bytes.length > MAX_TRANSFER_BYTES)
          throw rateLimited('图片传输缓存已满，请稍后重试')
        const id = randomUUID()
        const expiry = setTimeout(() => this.close(id), 60_000)
        expiry.unref()
        this.transfers.set(id, { bytes, timer: expiry })
        this.transferBytes += bytes.length
        return { id, mime, size: bytes.length, chunkSize: CHUNK_BYTES }
      }
      throw unavailable('图片跳转次数过多')
    } catch (error) {
      if (controller.signal.aborted) throw timedOut('图片下载超时，请检查采集代理后重试')
      if (isPluginFailure(error)) throw error
      if (error instanceof RangeError) throw unavailable('图片超过 8 MiB 上限')
      throw unavailable('图片下载失败，请检查采集代理后重试')
    } finally {
      clearTimeout(timer)
      this.downloading--
    }
  }

  read(id: string, offset: number) {
    const transfer = this.transfers.get(id)
    if (!transfer) throw unavailable('图片传输已过期，请重新加载')
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= transfer.bytes.length ||
      offset % CHUNK_BYTES !== 0
    )
      throw invalidRequest('图片分块偏移无效')
    return {
      offset,
      data: transfer.bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64'),
    }
  }
  close(id: string) {
    const transfer = this.transfers.get(id)
    if (transfer) {
      clearTimeout(transfer.timer)
      this.transferBytes -= transfer.bytes.length
      this.transfers.delete(id)
    }
    return { closed: true }
  }
}
