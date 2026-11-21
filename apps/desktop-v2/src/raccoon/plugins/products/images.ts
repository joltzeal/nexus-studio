import {
  IMAGE_CHUNK_BYTES,
  ImageChunkSchema,
  ImageReadSchema,
  ProductImageSchema,
  ImageDiscardSchema,
  ImageDiscardReplySchema,
  UploadBeginSchema,
  UploadBeginReplySchema,
  UploadChunkSchema,
  UploadChunkReplySchema,
  UploadFinishSchema,
  UploadFinishReplySchema,
  UploadAbortSchema,
  UploadAbortReplySchema,
  type ProductImage,
} from '@nexus/plugin-contracts/products'
import { callProducts } from './api'

function encode(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

async function imageDigest(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.length)
  new Uint8Array(buffer).set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export async function discardProductImages(ids: string[]): Promise<void> {
  const input = ImageDiscardSchema.parse({ ids: [...new Set(ids)] })
  if (!input.ids.length) return
  const reply = ImageDiscardReplySchema.parse(
    await callProducts('products.images.discard', input),
  )
  if (reply.removed > input.ids.length) throw new Error('图片清理结果无效。')
}

export async function uploadProductBytes(
  input: { bytes: Uint8Array; mime: string; name: string },
  signal?: AbortSignal,
): Promise<ProductImage> {
  signal?.throwIfAborted()
  const parsed = UploadBeginSchema.parse({ mime: input.mime, size: input.bytes.length })
  const name = input.name
    .trim()
    .slice(0, 200)
    .replace(/[\uD800-\uDBFF]$/, '')
  if (!name) throw new Error('请提供有效图片名称。')
  const digest = await imageDigest(input.bytes)
  signal?.throwIfAborted()
  const begun = UploadBeginReplySchema.parse(
    await callProducts('products.upload.begin', parsed),
  )
  let finished: ProductImage | null = null
  try {
    signal?.throwIfAborted()
    if (begun.chunkSize < Math.ceil(input.bytes.length / 10_000))
      throw new Error('商品插件上传分块过小，请更新插件。')
    const step = Math.min(begun.chunkSize, IMAGE_CHUNK_BYTES)
    for (
      let offset = 0, index = 0;
      offset < input.bytes.length;
      offset += step, index += 1
    ) {
      signal?.throwIfAborted()
      const chunk = UploadChunkSchema.parse({
        uploadId: begun.uploadId,
        index,
        data: encode(input.bytes.subarray(offset, offset + step)),
      })
      UploadChunkReplySchema.parse(await callProducts('products.upload.chunk', chunk))
      signal?.throwIfAborted()
    }
    signal?.throwIfAborted()
    const finish = UploadFinishSchema.parse({
      uploadId: begun.uploadId,
      name,
    })
    finished = UploadFinishReplySchema.parse(
      await callProducts('products.upload.finish', finish),
    ).image
    if (
      finished.mime !== parsed.mime ||
      finished.bytes !== input.bytes.length ||
      finished.sha256 !== digest
    )
      throw new Error('保存的图片与上传内容不一致。')
    signal?.throwIfAborted()
    return finished
  } catch (error) {
    if (finished !== null)
      await discardProductImages([finished.id]).catch(() => undefined)
    else
      await callProducts(
        'products.upload.abort',
        UploadAbortSchema.parse({ uploadId: begun.uploadId }),
      )
        .then((value) => UploadAbortReplySchema.parse(value))
        .catch(() => undefined)
    throw error
  }
}

export async function readProductImage(
  input: ProductImage,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const image = ProductImageSchema.parse(input)
  const bytes = new Uint8Array(image.bytes)
  for (let offset = 0; offset < image.bytes;) {
    signal?.throwIfAborted()
    const request = ImageReadSchema.parse({
      imageId: image.id,
      offset,
      length: IMAGE_CHUNK_BYTES,
    })
    const chunk = ImageChunkSchema.parse(
      await callProducts('products.images.read', request),
    )
    signal?.throwIfAborted()
    const decoded = Uint8Array.from(atob(chunk.data), (value) => value.charCodeAt(0))
    if (
      encode(decoded) !== chunk.data ||
      chunk.total !== image.bytes ||
      decoded.length !== Math.min(request.length, image.bytes - offset) ||
      chunk.next !== offset + decoded.length ||
      chunk.done !== (chunk.next === image.bytes)
    )
      throw new Error('图片分块不完整或偏移无效。')
    bytes.set(decoded, offset)
    offset = chunk.next
  }
  if ((await imageDigest(bytes)) !== image.sha256) throw new Error('图片完整性校验失败。')
  signal?.throwIfAborted()
  return bytes
}
