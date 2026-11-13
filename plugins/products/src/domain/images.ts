import { createHash } from 'node:crypto'
import { IMAGE_CHUNK_BYTES, MAX_IMAGE_BYTES } from '../contracts.js'
import { invalidRequest } from './errors.js'

export function imageHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function imageMime(
  bytes: Buffer,
): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg'
  if (
    bytes.length >= 16 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16)) &&
    bytes.readUInt32LE(4) === bytes.length - 8
  )
    return 'image/webp'
  return null
}

export function validateImageBytes(bytes: Buffer, mime: string): void {
  if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES || imageMime(bytes) !== mime)
    throw invalidRequest('图片内容与格式不符，仅支持 8 MiB 以内的 PNG、JPEG 和 WebP')
}

export function decodeImageChunk(data: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
    throw invalidRequest('图片分块必须使用规范的 base64')
  const bytes = Buffer.from(data, 'base64')
  if (
    bytes.length === 0 ||
    bytes.length > IMAGE_CHUNK_BYTES ||
    bytes.toString('base64') !== data
  )
    throw invalidRequest('图片分块编码或大小无效')
  return bytes
}
