import { randomUUID } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import {
  MAX_IMAGE_BYTES,
  ProductDraftSchema,
  ProductImageSchema,
  ProductPublicationSchema,
  ProductSchema,
  type ProductImage,
} from '../contracts.js'
import { invalidRequest, isPluginFailure, unavailable } from '../domain/errors.js'
import { imageHash, imageMime, validateImageBytes } from '../domain/images.js'
import { publicationListingKey } from '../domain/publications.js'

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024
const StoredProductSchema = ProductSchema.omit({
  publicationCount: true,
  latestPublication: true,
}).extend({
  publications: z.array(ProductPublicationSchema),
})
export type StoredProduct = z.infer<typeof StoredProductSchema>

const ReceiptSchema = z.strictObject({
  kind: z.enum(['create', 'ai', 'import']),
  key: z.string().min(1).max(128),
  productId: z.uuid(),
})
const UploadReceiptSchema = z.strictObject({
  uploadId: z.uuid(),
  imageId: z.uuid(),
})
const PublicationReceiptSchema = z.strictObject({
  productId: z.uuid(),
  publication: ProductPublicationSchema,
})
const DocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  nextSequence: z.number().int().min(1),
  products: z.array(StoredProductSchema),
  images: z.array(ProductImageSchema),
  receipts: z.array(ReceiptSchema),
  uploadReceipts: z.array(UploadReceiptSchema),
  publicationReceipts: z.array(PublicationReceiptSchema),
})
export type StoreDocument = z.infer<typeof DocumentSchema>
export type AssertAlive = () => void

export interface ProductsStore {
  readonly durable: boolean
  read(): Promise<StoreDocument>
  mutate<T>(
    apply: (document: StoreDocument) => T | Promise<T>,
    assertAlive?: AssertAlive,
  ): Promise<T>
  putImage(
    bytes: Buffer,
    input: { mime: ProductImage['mime']; name: string; uploadId?: string },
    assertAlive?: AssertAlive,
  ): Promise<ProductImage>
  readImage(
    id: string,
    assertAlive?: AssertAlive,
  ): Promise<{ image: ProductImage; bytes: Buffer }>
}

export function emptyDocument(): StoreDocument {
  return {
    schemaVersion: 1,
    nextSequence: 1,
    products: [],
    images: [],
    receipts: [],
    uploadReceipts: [],
    publicationReceipts: [],
  }
}

function validate(input: unknown): StoreDocument {
  const parsed = DocumentSchema.safeParse(input)
  if (!parsed.success) throw unavailable('商品存储结构无效，原数据未被清空')
  const document = parsed.data
  const ids = new Set<string>()
  const sequences = new Set<number>()
  const images = new Map(document.images.map((image) => [image.id, image]))
  if (images.size !== document.images.length)
    throw unavailable('商品图片索引重复，原数据未被清空')
  const referenced = new Set(
    document.products.flatMap((product) => product.images.map((image) => image.id)),
  )
  const uploadIds = new Set<string>()
  const uploadedImages = new Set<string>()
  for (const receipt of document.uploadReceipts) {
    if (
      uploadIds.has(receipt.uploadId) ||
      uploadedImages.has(receipt.imageId) ||
      !images.has(receipt.imageId) ||
      referenced.has(receipt.imageId)
    )
      throw unavailable('商品上传记录无效，原数据未被清空')
    uploadIds.add(receipt.uploadId)
    uploadedImages.add(receipt.imageId)
  }
  const receiptKeys = new Set<string>()
  const receiptProductIds = new Set<string>()
  for (const receipt of document.receipts) {
    const key = `${receipt.kind}:${receipt.key}`
    if (receiptKeys.has(key)) throw unavailable('商品导入记录重复，原数据未被清空')
    receiptKeys.add(key)
    receiptProductIds.add(receipt.productId)
  }
  const publicationReceipts = new Map<string, z.infer<typeof PublicationReceiptSchema>>()
  const operationIds = new Set<string>()
  const listings = new Set<string>()
  for (const receipt of document.publicationReceipts) {
    const publication = receipt.publication
    const listing = publicationListingKey(publication)
    if (
      !receiptProductIds.has(receipt.productId) ||
      publicationReceipts.has(publication.id) ||
      operationIds.has(publication.operationId) ||
      listings.has(listing)
    )
      throw unavailable('商品发布记录重复，原数据未被清空')
    publicationReceipts.set(publication.id, receipt)
    operationIds.add(publication.operationId)
    listings.add(listing)
  }
  for (const product of document.products) {
    if (
      ids.has(product.id) ||
      sequences.has(product.sequence) ||
      product.sequence >= document.nextSequence
    )
      throw unavailable('商品标识或创建顺序无效，原数据未被清空')
    ids.add(product.id)
    sequences.add(product.sequence)
    const source = product.source
    const references = product.images
    const fields = Object.fromEntries(
      Object.entries(product).filter(
        ([key]) =>
          ![
            'id',
            'revision',
            'sequence',
            'source',
            'images',
            'publications',
            'createdAt',
            'updatedAt',
          ].includes(key),
      ),
    )
    if (
      !ProductDraftSchema.safeParse({
        ...fields,
        imageIds: references.map((image) => image.id),
      }).success
    )
      throw unavailable('商品资料或状态无效，原数据未被清空')
    for (const image of references) {
      if (JSON.stringify(images.get(image.id)) !== JSON.stringify(image))
        throw unavailable('商品图片索引不完整，原数据未被清空')
    }
    const publicationIds = new Set<string>()
    for (const publication of product.publications) {
      const receipt = publicationReceipts.get(publication.id)
      if (
        publicationIds.has(publication.id) ||
        publication.productRevision > product.revision ||
        receipt?.productId !== product.id ||
        JSON.stringify(receipt.publication) !== JSON.stringify(publication)
      )
        throw unavailable('商品发布记录不一致，原数据未被清空')
      publicationIds.add(publication.id)
    }
    const receiptKind =
      source.kind === 'manual' ? 'create' : source.kind === 'ai-image' ? 'ai' : 'import'
    if (
      !document.receipts.some(
        (receipt) =>
          receipt.kind === receiptKind &&
          receipt.productId === product.id &&
          (source.kind === 'manual' ||
            receipt.key === (source.kind === 'ai-image' ? source.recordId : source.key)),
      )
    )
      throw unavailable('商品创建记录不完整，原数据未被清空')
  }
  for (const receipt of document.receipts) {
    const product = document.products.find((entry) => entry.id === receipt.productId)
    if (!product) continue
    if (
      (receipt.kind === 'create' && product.source.kind !== 'manual') ||
      (receipt.kind === 'ai' &&
        (product.source.kind !== 'ai-image' ||
          product.source.recordId !== receipt.key)) ||
      (receipt.kind === 'import' &&
        (product.source.kind !== 'import' || product.source.key !== receipt.key))
    )
      throw unavailable('商品来源记录不一致，原数据未被清空')
  }
  for (const receipt of document.publicationReceipts) {
    const product = document.products.find((entry) => entry.id === receipt.productId)
    if (
      product &&
      !product.publications.some(
        (publication) => publication.id === receipt.publication.id,
      )
    )
      throw unavailable('商品发布收据不完整，原数据未被清空')
  }
  return document
}

function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

class PrivateStore implements ProductsStore {
  readonly durable: boolean
  private document: StoreDocument | null = null
  private loading: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly memoryImages = new Map<string, Buffer>()
  private readonly directory: string | null

  constructor(directory: string | null) {
    this.directory = directory === null ? null : resolve(directory)
    this.durable = directory !== null
  }

  async read(): Promise<StoreDocument> {
    await this.load()
    return structuredClone(this.document!)
  }

  mutate<T>(
    apply: (document: StoreDocument) => T | Promise<T>,
    assertAlive: AssertAlive = () => {},
  ): Promise<T> {
    return this.enqueue(async () => {
      assertAlive()
      await this.load()
      assertAlive()
      const draft = structuredClone(this.document!)
      const result = await apply(draft)
      assertAlive()
      const indexed = new Set(draft.images.map((image) => image.id))
      const referenced = new Set(
        draft.products.flatMap((product) => product.images.map((image) => image.id)),
      )
      // Committing a product transfers image ownership away from its upload receipt.
      draft.uploadReceipts = draft.uploadReceipts.filter(
        (receipt) => indexed.has(receipt.imageId) && !referenced.has(receipt.imageId),
      )
      const valid = validate(draft)
      if (JSON.stringify(valid) !== JSON.stringify(this.document)) {
        if (this.directory !== null) await this.persist(valid, assertAlive)
        else assertAlive()
        const previous = this.document!
        this.document = valid
        // Cleanup follows the document commit and runs under the same write queue.
        await this.cleanup(
          previous.images.filter(
            (image) => !valid.images.some((entry) => entry.id === image.id),
          ),
          assertAlive,
        )
      }
      return structuredClone(result)
    })
  }

  putImage(
    inputBytes: Buffer,
    input: { mime: ProductImage['mime']; name: string; uploadId?: string },
    assertAlive: AssertAlive = () => {},
  ): Promise<ProductImage> {
    const bytes = Buffer.from(inputBytes)
    return this.enqueue(async () => {
      assertAlive()
      await this.load()
      assertAlive()
      const existing = input.uploadId
        ? this.document!.uploadReceipts.find(
            (receipt) => receipt.uploadId === input.uploadId,
          )
        : undefined
      if (existing) return (await this.readImage(existing.imageId, assertAlive)).image
      validateImageBytes(bytes, input.mime)
      const parsed = ProductImageSchema.safeParse({
        id: randomUUID(),
        name: input.name,
        mime: input.mime,
        bytes: bytes.length,
        sha256: imageHash(bytes),
      })
      if (!parsed.success) throw invalidRequest('图片资料无效')
      const image = parsed.data
      const draft = structuredClone(this.document!)
      draft.images.push(image)
      if (input.uploadId !== undefined) {
        const receipt = UploadReceiptSchema.safeParse({
          uploadId: input.uploadId,
          imageId: image.id,
        })
        if (!receipt.success) throw invalidRequest('图片上传标识无效')
        draft.uploadReceipts.push(receipt.data)
      }
      const valid = validate(draft)
      let published = false
      let bytesWritten = false
      try {
        if (this.directory !== null) {
          await this.ensureDirectory(this.directory, true)
          await this.ensureDirectory(join(this.directory, 'images'), true)
          assertAlive()
          await this.atomicWrite(
            join(this.directory, 'images', `${image.id}.bin`),
            bytes,
            assertAlive,
          )
          bytesWritten = true
          await this.persist(valid, assertAlive)
        } else {
          assertAlive()
          this.memoryImages.set(image.id, bytes)
        }
        this.document = valid
        published = true
        return structuredClone(image)
      } catch (error) {
        if (isPluginFailure(error)) throw error
        throw unavailable('商品图片写入失败，本次图片未保存')
      } finally {
        if (!published && bytesWritten && this.directory !== null)
          await this.safeUnlink(image.id).catch(() => undefined)
      }
    })
  }

  async readImage(
    id: string,
    assertAlive: AssertAlive = () => {},
  ): Promise<{ image: ProductImage; bytes: Buffer }> {
    assertAlive()
    await this.load()
    assertAlive()
    const image = this.document!.images.find((entry) => entry.id === id)
    if (!image) throw invalidRequest('图片不存在或已移除，请重新上传')
    try {
      const bytes =
        this.directory === null
          ? this.memoryImages.get(id)
          : await this.readOwnedFile(
              join(this.directory, 'images', `${image.id}.bin`),
              MAX_IMAGE_BYTES,
              true,
            )
      assertAlive()
      if (
        !bytes ||
        bytes.length !== image.bytes ||
        imageHash(bytes) !== image.sha256 ||
        imageMime(bytes) !== image.mime
      )
        throw unavailable('商品图片缺失或校验失败，请恢复原图片或重新上传')
      return { image: structuredClone(image), bytes: Buffer.from(bytes) }
    } catch (error) {
      if (isPluginFailure(error)) throw error
      throw unavailable('商品图片读取失败，请检查插件图片目录')
    }
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async load(): Promise<void> {
    if (this.document !== null) return
    const loading = (this.loading ??= this.loadDocument())
    try {
      await loading
    } finally {
      if (this.loading === loading) this.loading = null
    }
  }

  private async loadDocument(): Promise<void> {
    if (this.directory === null) {
      this.document = emptyDocument()
      return
    }
    try {
      const bytes = await this.readOwnedFile(
        join(this.directory, 'products.json'),
        MAX_DOCUMENT_BYTES,
      )
      this.document = validate(JSON.parse(bytes.toString('utf8')))
    } catch (error) {
      if (missing(error)) {
        this.document = emptyDocument()
        return
      }
      throw unavailable('商品存储读取失败，请检查插件数据文件；原数据未被清空')
    }
  }

  private async ensureDirectory(directory: string, create = false): Promise<void> {
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw unavailable('商品存储目录必须为真实私有目录，不能使用符号链接')
  }

  private async readOwnedFile(
    file: string,
    maxBytes: number,
    image = false,
  ): Promise<Buffer> {
    await this.ensureDirectory(this.directory!)
    if (image) await this.ensureDirectory(join(this.directory!, 'images'))
    const before = await fs.lstat(file)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > maxBytes
    )
      throw unavailable('商品存储文件类型或大小无效')
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const current = await handle.stat()
      if (!current.isFile() || current.nlink !== 1 || current.size > maxBytes)
        throw unavailable('商品存储文件类型或大小无效')
      const bytes = await handle.readFile()
      if (bytes.length > maxBytes) throw unavailable('商品存储文件超过大小上限')
      return bytes
    } finally {
      await handle.close()
    }
  }

  private async persist(
    document: StoreDocument,
    assertAlive: AssertAlive,
  ): Promise<void> {
    try {
      assertAlive()
      await this.ensureDirectory(this.directory!, true)
      const file = join(this.directory!, 'products.json')
      try {
        const existing = await fs.lstat(file)
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
          throw unavailable('商品存储文件类型无效')
      } catch (error) {
        if (!missing(error)) throw error
      }
      const bytes = Buffer.from(`${JSON.stringify(document)}\n`)
      if (bytes.length > MAX_DOCUMENT_BYTES) throw unavailable('商品存储超过大小上限')
      await this.atomicWrite(file, bytes, assertAlive)
    } catch (error) {
      if (isPluginFailure(error)) throw error
      throw unavailable('商品存储写入失败，本次修改未保存')
    }
  }

  private async atomicWrite(
    file: string,
    bytes: Buffer,
    assertAlive: AssertAlive,
  ): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      assertAlive()
      const handle = await fs.open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.ensureDirectory(this.directory!)
      if (file.endsWith('.bin'))
        await this.ensureDirectory(join(this.directory!, 'images'))
      assertAlive()
      await fs.rename(temporary, file)
    } finally {
      await fs.unlink(temporary).catch(() => undefined)
    }
  }

  private async safeUnlink(id: string): Promise<void> {
    if (this.directory === null) {
      this.memoryImages.delete(id)
      return
    }
    await this.ensureDirectory(this.directory)
    await this.ensureDirectory(join(this.directory, 'images'))
    const file = join(this.directory, 'images', `${id}.bin`)
    const info = await fs.lstat(file)
    if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1) await fs.unlink(file)
  }

  private async cleanup(images: ProductImage[], assertAlive: AssertAlive): Promise<void> {
    for (const image of images) {
      try {
        assertAlive()
        await this.safeUnlink(image.id)
      } catch {
        // A committed deletion can leave an orphan file; it must never undo the document.
      }
    }
  }
}

export function createFileStore(directory: string): ProductsStore {
  return new PrivateStore(directory)
}

export function createMemoryStore(): ProductsStore {
  return new PrivateStore(null)
}
