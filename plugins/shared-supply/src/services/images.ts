import { randomUUID } from 'node:crypto'
import {
  invalidRequest,
  isPluginFailure,
  rateLimited,
  timedOut,
  unavailable,
} from '../domain/errors.js'
import { supplyImageUrl } from '../domain/image-url.js'
import type { DispatchContext } from '../rpc/protocol.js'

const MAX_BYTES = 8 * 1024 * 1024
// 256 KiB becomes ~342 KiB of base64, safely below the host's 1 MiB JSON line.
const CHUNK_BYTES = 256 * 1024
const MAX_TRANSFER_BYTES = 32 * 1024 * 1024
const TRANSFER_TTL_MS = 60_000
const TIMEOUT_MS = 20_000
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

interface Transfer {
  bytes: Buffer
  timer: ReturnType<typeof setTimeout>
}

function imageMime(bytes: Buffer): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png'
  }
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

async function readImage(response: Response, context: DispatchContext): Promise<Buffer> {
  if (response.body === null) throw unavailable('图片响应为空')
  const reader = response.body.getReader()
  let complete = false
  try {
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      throw unavailable('图片超过 8 MiB 上限')
    }
    const parts: Buffer[] = []
    let size = 0
    while (true) {
      context.assertAlive()
      const { done, value } = await reader.read()
      if (done) {
        complete = true
        break
      }
      size += value.byteLength
      if (size > MAX_BYTES) throw unavailable('图片超过 8 MiB 上限')
      parts.push(Buffer.from(value))
    }
    if (size === 0) throw unavailable('图片响应为空')
    return Buffer.concat(parts, size)
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/**
 * Uses the same Node fetch dispatcher as catalogue calls, including the host's
 * application proxy. Transfers are immutable, short-lived and memory-only.
 */
export class SharedSupplyImages {
  private readonly fetchImpl: typeof fetch
  private readonly transfers = new Map<string, Transfer>()
  private transferBytes = 0
  private downloading = 0

  constructor(options: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async open(value: string, context: DispatchContext) {
    let url = supplyImageUrl(value)
    if (url === null) throw invalidRequest('不支持的货源图片地址')
    context.assertAlive()
    if (this.downloading >= 4 || this.transfers.size + this.downloading >= 8) {
      throw rateLimited('图片请求较多，请稍后重试')
    }
    this.downloading += 1
    const signal = AbortSignal.timeout(
      Math.max(1, Math.min(TIMEOUT_MS, context.deadlineAt - Date.now())),
    )
    try {
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        const response = await this.fetchImpl(url, {
          signal,
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: { Accept: 'image/jpeg, image/png, image/webp, image/gif' },
        })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel()
          const location = response.headers.get('location')
          let next: URL | null = null
          try {
            if (location !== null) next = new URL(location, url)
          } catch {
            // Malformed redirects are treated like any other untrusted target.
          }
          if (next?.protocol !== 'https:' || redirects === 3) {
            throw unavailable('图片服务返回了不支持的跳转')
          }
          url = supplyImageUrl(next.href)
          if (url === null) throw unavailable('图片跳转地址不在允许范围内')
          continue
        }
        const declaredMime = (response.headers.get('content-type') ?? '')
          .split(';')[0]!
          .trim()
          .toLowerCase()
        if (
          !response.ok ||
          (!MIME_TYPES.has(declaredMime) && declaredMime !== 'application/octet-stream')
        ) {
          await response.body?.cancel()
          if (response.status === 429)
            throw rateLimited('图片服务请求过于频繁，请稍后重试')
          if (response.status === 408 || response.status === 504)
            throw timedOut('图片服务响应超时，请重试')
          throw unavailable('图片服务不可用或返回了不支持的内容类型')
        }
        const bytes = await readImage(response, context)
        const mime = imageMime(bytes)
        if (
          mime === null ||
          (declaredMime !== 'application/octet-stream' && declaredMime !== mime)
        ) {
          throw unavailable('图片内容与类型不符或格式不受支持')
        }
        context.assertAlive()
        if (this.transferBytes + bytes.byteLength > MAX_TRANSFER_BYTES) {
          throw rateLimited('图片传输缓存已满，请稍后重试')
        }
        const id = randomUUID()
        const timer = setTimeout(() => this.close(id), TRANSFER_TTL_MS)
        timer.unref()
        this.transfers.set(id, { bytes, timer })
        this.transferBytes += bytes.byteLength
        return { id, mime, size: bytes.byteLength, chunkSize: CHUNK_BYTES }
      }
      throw unavailable('图片跳转次数过多')
    } catch (error) {
      if (isPluginFailure(error)) throw error
      if (signal.aborted) throw timedOut('图片下载超时，请检查应用代理后重试')
      // Never expose URLs, proxy addresses or raw network diagnostics.
      throw unavailable('图片下载失败，请检查网络和应用代理后重试')
    } finally {
      this.downloading -= 1
    }
  }

  read(id: string, offset: number) {
    const transfer = this.transfers.get(id)
    if (transfer === undefined) throw unavailable('图片传输已过期，请重新加载')
    if (offset >= transfer.bytes.length || offset % CHUNK_BYTES !== 0) {
      throw invalidRequest('图片分块偏移无效')
    }
    const chunk = transfer.bytes.subarray(offset, offset + CHUNK_BYTES)
    return { offset, data: chunk.toString('base64') }
  }

  close(id: string) {
    const transfer = this.transfers.get(id)
    if (transfer !== undefined) {
      clearTimeout(transfer.timer)
      this.transferBytes -= transfer.bytes.byteLength
      this.transfers.delete(id)
    }
    return { closed: true }
  }
}
