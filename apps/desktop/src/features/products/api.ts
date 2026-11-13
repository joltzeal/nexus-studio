import {
  IMAGE_CHUNK_BYTES,
  MAX_IMAGE_BYTES,
  PRODUCTS_PLUGIN_ID,
  PRODUCT_CAPABILITY,
  compareProductPublicationRecency,
  ImageChunkSchema,
  ImageDiscardReplySchema,
  ImageDiscardSchema,
  ImageMimeSchema,
  ProductGetSchema,
  ProductImportReportSchema,
  ProductImportSchema,
  ProductPageSchema,
  ProductPublicationPageSchema,
  ProductPublicationQuerySchema,
  ProductQuerySchema,
  ProductRemoveReplySchema,
  ProductRemoveSchema,
  ProductReplySchema,
  ProductSaveReplySchema,
  ProductSaveSchema,
  UploadBeginReplySchema,
  UploadBeginSchema,
  UploadChunkReplySchema,
  UploadFinishReplySchema,
  type Product,
  type ProductImage,
  type ProductImportReport,
  type ProductPage,
  type ProductPublicationPage,
  type ProductPublicationQuery,
  type ProductQuery,
  type ProductSave,
} from '@nexus/plugin-products/contracts'
import { callPlugin } from '@/lib/platform/native-plugins'

const DEADLINE = 30_000

export function callProducts(method: string, payload: unknown): Promise<unknown> {
  return callPlugin(PRODUCTS_PLUGIN_ID, PRODUCT_CAPABILITY, method, payload, DEADLINE)
}

export async function listProducts(query: Partial<ProductQuery>): Promise<ProductPage> {
  const input = ProductQuerySchema.parse(query)
  const result = ProductPageSchema.parse(await callProducts('products.list', input))
  const expectedPage = Math.min(
    input.page,
    Math.max(1, Math.ceil(result.total / input.pageSize)),
  )
  if (
    result.page !== expectedPage ||
    result.pageSize !== input.pageSize ||
    result.items.length > result.pageSize ||
    result.items.length > result.total ||
    new Set(result.items.map((product) => product.id)).size !== result.items.length ||
    result.items.some(
      (product) =>
        (input.status !== undefined && product.status !== input.status) ||
        (input.sourceKind !== undefined && product.source.kind !== input.sourceKind) ||
        (input.publicationStatus === 'published' && product.publicationCount === 0) ||
        (input.publicationStatus === 'unpublished' && product.publicationCount > 0) ||
        (product.publicationCount === 0) !== (product.latestPublication === null) ||
        (product.imageCount === 0) !== (product.cover === null),
    )
  )
    throw new Error('商品插件返回的分页资料不一致，请刷新后重试。')
  return result
}

export async function listProductPublications(
  query: Pick<ProductPublicationQuery, 'productId'> & Partial<ProductPublicationQuery>,
): Promise<ProductPublicationPage> {
  const input = ProductPublicationQuerySchema.parse(query)
  const result = ProductPublicationPageSchema.parse(
    await callProducts('products.publications.list', input),
  )
  const expectedPage = Math.min(
    input.page,
    Math.max(1, Math.ceil(result.total / input.pageSize)),
  )
  const expectedCount = Math.min(
    input.pageSize,
    Math.max(0, result.total - (expectedPage - 1) * input.pageSize),
  )
  if (
    result.productId !== input.productId ||
    result.page !== expectedPage ||
    result.pageSize !== input.pageSize ||
    result.items.length !== expectedCount ||
    new Set(result.items.map((publication) => publication.id)).size !==
      result.items.length ||
    result.items.some(
      (publication, index) =>
        publication.productRevision > result.productRevision ||
        (index > 0 &&
          compareProductPublicationRecency(result.items[index - 1]!, publication) < 0),
    )
  )
    throw new Error('商品插件返回的发布历史分页资料不一致，请刷新后重试。')
  return result
}

export async function getProduct(id: string): Promise<Product> {
  const input = ProductGetSchema.parse({ id })
  const { product } = ProductReplySchema.parse(await callProducts('products.get', input))
  if (product.id !== id) throw new Error('商品插件返回了不同的商品，请刷新后重试。')
  return product
}

export async function saveProduct(input: ProductSave): Promise<Product> {
  const parsed = ProductSaveSchema.parse(input)
  const reply = ProductSaveReplySchema.parse(await callProducts('products.save', parsed))
  if (
    parsed.id &&
    (reply.product.id !== parsed.id ||
      reply.product.revision !== (parsed.expectedRevision ?? 0) + 1)
  )
    throw new Error('商品保存结果不一致，请刷新确认后再编辑。')
  const keys = Object.keys(parsed.data) as (keyof typeof parsed.data)[]
  const matches = keys.every((key) => {
    const value =
      key === 'imageIds'
        ? reply.product.images.map((image) => image.id)
        : reply.product[key]
    return JSON.stringify(value) === JSON.stringify(parsed.data[key])
  })
  if (!matches)
    throw new Error(
      reply.alreadySaved
        ? '此请求已创建商品，但与当前表单不同。请关闭后从列表编辑已创建的商品。'
        : '商品保存返回的资料不一致，请刷新确认后再编辑。',
    )
  return reply.product
}

export async function removeProduct(product: {
  id: string
  revision: number
}): Promise<void> {
  const input = ProductRemoveSchema.parse({
    id: product.id,
    expectedRevision: product.revision,
  })
  const reply = ProductRemoveReplySchema.parse(
    await callProducts('products.remove', input),
  )
  if (reply.id !== product.id) throw new Error('商品删除结果不一致，请刷新确认。')
}

export async function importProductText(
  format: 'csv' | 'json',
  content: string,
): Promise<ProductImportReport> {
  const input = ProductImportSchema.parse({ format, content })
  if (new TextEncoder().encode(content).byteLength > 512 * 1024)
    throw new Error('导入文件不能超过 512 KiB。')
  const reply = ProductImportReportSchema.parse(
    await callProducts('products.import', input),
  )
  if (
    reply.total !== reply.inserted + reply.skipped ||
    reply.errors.length > reply.skipped ||
    new Set(reply.errors.map((error) => error.row)).size !== reply.errors.length
  )
    throw new Error('商品导入结果不完整，请刷新列表确认。')
  return reply
}

export function encodeImageBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

export function decodeImageBytes(data: string): Uint8Array {
  if (
    data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  )
    throw new Error('图片分块编码无效。')
  const binary = atob(data)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (encodeImageBytes(bytes) !== data) throw new Error('图片分块编码无效。')
  return bytes
}

export async function imageDigest(bytes: Uint8Array): Promise<string> {
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
  for (const id of input.ids) releaseImage(id)
}

export async function uploadProductBytes(
  input: { bytes: Uint8Array; mime: string; name: string },
  signal?: AbortSignal,
): Promise<ProductImage> {
  signal?.throwIfAborted()
  const parsed = UploadBeginSchema.parse({ mime: input.mime, size: input.bytes.length })
  const digest = await imageDigest(input.bytes)
  signal?.throwIfAborted()
  const begun = UploadBeginReplySchema.parse(
    await callProducts('products.upload.begin', parsed),
  )
  let finished: ProductImage | null = null
  try {
    signal?.throwIfAborted()
    for (let offset = 0, index = 0; offset < input.bytes.length; index += 1) {
      signal?.throwIfAborted()
      const end = Math.min(offset + begun.chunkSize, input.bytes.length)
      UploadChunkReplySchema.parse(
        await callProducts('products.upload.chunk', {
          uploadId: begun.uploadId,
          index,
          data: encodeImageBytes(input.bytes.subarray(offset, end)),
        }),
      )
      offset = end
    }
    signal?.throwIfAborted()
    const reply = UploadFinishReplySchema.parse(
      await callProducts('products.upload.finish', {
        uploadId: begun.uploadId,
        name: input.name,
      }),
    )
    finished = reply.image
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
      await callProducts('products.upload.abort', { uploadId: begun.uploadId }).catch(
        () => undefined,
      )
    throw error
  }
}

export async function uploadProductImage(
  file: File,
  signal?: AbortSignal,
): Promise<ProductImage> {
  signal?.throwIfAborted()
  UploadBeginSchema.parse({ mime: file.type, size: file.size })
  return uploadProductBytes(
    {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type,
      name: file.name,
    },
    signal,
  )
}

export function validateImageChunk(
  value: unknown,
  offset: number,
  total: number,
): { bytes: Uint8Array; next: number; done: boolean } {
  const chunk = ImageChunkSchema.parse(value)
  const bytes = decodeImageBytes(chunk.data)
  if (
    chunk.total !== total ||
    bytes.length < 1 ||
    bytes.length > IMAGE_CHUNK_BYTES ||
    chunk.next !== offset + bytes.length ||
    chunk.next > total ||
    chunk.done !== (chunk.next === total)
  )
    throw new Error('图片分块不完整或读取进度无效。')
  return { bytes, next: chunk.next, done: chunk.done }
}

const imageUrls = new Map<string, { key: string; pending: Promise<string> }>()
const CACHE_SIZE = 80

function releaseImage(id: string): void {
  const entry = imageUrls.get(id)
  imageUrls.delete(id)
  if (entry)
    void entry.pending.then((url) => URL.revokeObjectURL(url)).catch(() => undefined)
}

export function releaseProductImageUrls(): void {
  for (const id of imageUrls.keys()) releaseImage(id)
}

export function productImageUrl(image: ProductImage): Promise<string> {
  const key = `${image.sha256}:${image.bytes}:${image.mime}`
  const cached = imageUrls.get(image.id)
  if (cached?.key === key) return cached.pending
  releaseImage(image.id)
  const pending = readProductImage(image).then((bytes) => {
    const buffer = new ArrayBuffer(bytes.length)
    new Uint8Array(buffer).set(bytes)
    return URL.createObjectURL(new Blob([buffer], { type: image.mime }))
  })
  imageUrls.set(image.id, { key, pending })
  pending.catch(() => {
    if (imageUrls.get(image.id)?.pending === pending) imageUrls.delete(image.id)
  })
  if (imageUrls.size > CACHE_SIZE) {
    const oldest = imageUrls.keys().next().value
    if (oldest !== undefined) releaseImage(oldest)
  }
  return pending
}

async function readProductImage(image: ProductImage): Promise<Uint8Array> {
  ImageMimeSchema.parse(image.mime)
  if (image.bytes < 1 || image.bytes > MAX_IMAGE_BYTES) throw new Error('图片大小无效。')
  const bytes = new Uint8Array(image.bytes)
  let offset = 0
  while (offset < image.bytes) {
    const chunk = validateImageChunk(
      await callProducts('products.images.read', {
        imageId: image.id,
        offset,
        length: IMAGE_CHUNK_BYTES,
      }),
      offset,
      image.bytes,
    )
    bytes.set(chunk.bytes, offset)
    offset = chunk.next
  }
  if ((await imageDigest(bytes)) !== image.sha256)
    throw new Error('图片校验失败，请重新导入图片。')
  return bytes
}
