import {
  parseSupplyImageClose,
  parseSupplyImageChunk,
  parseSupplyImageMeta,
  SUPPLY_IMAGE_MAX_BYTES,
  SUPPLY_IMAGE_MAX_CHUNK,
} from './image-parse'
import type { SupplyRpc } from './api'

const TRANSFER_ERROR = '图片传输数据无效，请刷新或更新共享货源插件。'

function decodeBase64(value: string, expected: number): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(TRANSFER_ERROR)
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new Error(TRANSFER_ERROR)
  }
  if (binary.length !== expected || btoa(binary) !== value) {
    throw new Error(TRANSFER_ERROR)
  }
  const bytes = new Uint8Array(expected)
  for (let index = 0; index < expected; index += 1)
    bytes[index] = binary.charCodeAt(index)
  return bytes
}

function imageError(error: unknown): Error {
  const text =
    typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  if (text === TRANSFER_ERROR) return new Error(text)
  if (/未声明该方法|不支持该方法/.test(text))
    return new Error('请更新共享货源插件后重试图片加载。')
  if (/TIMEOUT|超时/.test(text)) return new Error('图片加载超时，请检查应用代理后重试。')
  if (/RATE_LIMITED|频繁|缓存已满/.test(text))
    return new Error('图片请求较多，请稍后重试。')
  if (/超过.*上限/.test(text)) return new Error('图片超过 8 MiB 上限。')
  if (/类型|格式|内容/.test(text)) return new Error('图片内容或格式不受支持。')
  return new Error('图片加载失败，请检查网络和应用代理后重试。')
}

export function createSupplyImageReader(rpc: SupplyRpc) {
  return async function readImage(url: string, signal: AbortSignal): Promise<Blob> {
    signal.throwIfAborted()
    let id: string | null = null
    try {
      const meta = parseSupplyImageMeta(
        await rpc('supply.image.open', { url }, (value) => value, 40_000),
      )
      id = meta.id
      signal.throwIfAborted()
      if (meta.size > SUPPLY_IMAGE_MAX_BYTES || meta.chunkSize > SUPPLY_IMAGE_MAX_CHUNK) {
        throw new Error(TRANSFER_ERROR)
      }
      const bytes = new Uint8Array(meta.size)
      for (let offset = 0; offset < meta.size; offset += meta.chunkSize) {
        signal.throwIfAborted()
        const chunk = parseSupplyImageChunk(
          await rpc('supply.image.read', { id, offset }, (value) => value, 40_000),
        )
        signal.throwIfAborted()
        const expected = Math.min(meta.chunkSize, meta.size - offset)
        if (
          chunk.offset !== offset ||
          chunk.data.length !== Math.ceil(expected / 3) * 4
        ) {
          throw new Error(TRANSFER_ERROR)
        }
        bytes.set(decodeBase64(chunk.data, expected), offset)
      }
      return new Blob([bytes], { type: meta.mime })
    } catch (cause) {
      if (signal.aborted) throw cause
      throw imageError(cause)
    } finally {
      if (id !== null) {
        await rpc(
          'supply.image.close',
          { id },
          (value) => parseSupplyImageClose(value),
          40_000,
        ).catch(() => undefined)
      }
    }
  }
}
