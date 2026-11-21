import {
  VINTED_IMAGE_MAX_BYTES,
  VINTED_IMAGE_MAX_CHUNK,
  VINTED_IMAGE_MIME_TYPES,
  safeImageUrl,
} from './model.ts'
import { parseBoolean, parseObject } from './parse.ts'
import { vintedMonitorApi } from './api.ts'

type ImageMethods = Pick<
  typeof vintedMonitorApi,
  'imageOpen' | 'imageRead' | 'imageClose'
>
export type ImageCall = (
  method: string,
  payload: unknown,
  parse: (value: unknown) => unknown,
) => Promise<unknown>

const transferError = () => new Error('商品图片传输数据无效，请更新监控插件后重试。')

function required(value: unknown, key: string): unknown {
  const row = parseObject(value)
  if (!(key in row)) throw transferError()
  return row[key]
}

export class ImageTransferQueue {
  private readonly waiting: (() => void)[] = []
  private active = 0

  run<T>(signal: AbortSignal, transfer: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const index = this.waiting.indexOf(start)
        if (index < 0) return
        this.waiting.splice(index, 1)
        reject(signal.reason)
      }
      const start = () => {
        signal.removeEventListener('abort', cancel)
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        this.active += 1
        void Promise.resolve()
          .then(() => {
            signal.throwIfAborted()
            return transfer()
          })
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1
            this.pump()
          })
      }
      signal.addEventListener('abort', cancel, { once: true })
      this.waiting.push(start)
      this.pump()
    })
  }

  private pump(): void {
    while (this.active < 4 && this.waiting.length) this.waiting.shift()?.()
  }
}

const sharedQueue = new ImageTransferQueue()

export function createVintedImageLoader(
  api: ImageMethods | ImageCall = vintedMonitorApi,
) {
  return (itemId: string, url: string, signal: AbortSignal): Promise<Blob> =>
    sharedQueue.run(signal, () => transfer(api, itemId, url, signal))
}

async function transfer(
  api: ImageMethods | ImageCall,
  itemId: string,
  url: string,
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted()
  if (!safeImageUrl(url)) throw new Error('商品图片地址无效，请从商品图库重新选择。')
  let id: string | null = null
  try {
    const opened = parseObject(await imageCall(api, 'vinted.image.open', { itemId, url }))
    if (typeof opened.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(opened.id))
      throw transferError()
    id = opened.id
    signal.throwIfAborted()
    const { mime, size, chunkSize } = opened
    if (
      typeof mime !== 'string' ||
      !VINTED_IMAGE_MIME_TYPES.includes(
        mime as (typeof VINTED_IMAGE_MIME_TYPES)[number],
      ) ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > VINTED_IMAGE_MAX_BYTES ||
      typeof chunkSize !== 'number' ||
      !Number.isSafeInteger(chunkSize) ||
      chunkSize <= 0 ||
      chunkSize > VINTED_IMAGE_MAX_CHUNK
    )
      throw transferError()
    const bytes = new Uint8Array(size)
    for (let offset = 0; offset < size; offset += chunkSize) {
      signal.throwIfAborted()
      const chunk = parseObject(await imageCall(api, 'vinted.image.read', { id, offset }))
      signal.throwIfAborted()
      const expected = Math.min(chunkSize, size - offset)
      if (
        chunk.offset !== offset ||
        typeof chunk.data !== 'string' ||
        chunk.data.length !== Math.ceil(expected / 3) * 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.data)
      )
        throw transferError()
      const decoded = atob(chunk.data)
      if (decoded.length !== expected || btoa(decoded) !== chunk.data)
        throw transferError()
      for (let index = 0; index < decoded.length; index += 1)
        bytes[offset + index] = decoded.charCodeAt(index)
    }
    return new Blob([bytes], { type: mime })
  } catch (cause) {
    if (signal.aborted) signal.throwIfAborted()
    throw cause instanceof Error ? cause : transferError()
  } finally {
    if (id !== null) {
      try {
        parseBoolean(
          required(await imageCall(api, 'vinted.image.close', { id }), 'closed'),
        )
      } catch {
        // A completed byte read remains usable if a redundant close fails.
      }
    }
  }
}

function imageCall(
  api: ImageMethods | ImageCall,
  method: string,
  payload: unknown,
): Promise<unknown> {
  if (typeof api === 'function') return api(method, payload, (value) => value)
  if (method === 'vinted.image.open') {
    const input = payload as { itemId: string; url: string }
    return api.imageOpen(input.itemId, input.url)
  }
  if (method === 'vinted.image.read')
    return api.imageRead(
      (payload as { id: string; offset: number }).id,
      (payload as { id: string; offset: number }).offset,
    )
  return api.imageClose((payload as { id: string }).id)
}

export const loadVintedImage = createVintedImageLoader()
