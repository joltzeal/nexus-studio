import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import {
  IMAGE_CHUNK_BYTES,
  PRODUCT_CAPABILITY,
  compareProductPublicationRecency,
  ProductGetSchema,
  ProductImportAiSchema,
  ProductImportSchema,
  ProductPublicationInputSchema,
  ProductPublicationQuerySchema,
  ProductQuerySchema,
  ProductRemoveSchema,
  ProductSaveSchema,
  ProductSourceFindSchema,
  UploadAbortSchema,
  UploadBeginSchema,
  UploadChunkSchema,
  UploadFinishSchema,
  ImageDiscardSchema,
  ImageReadSchema,
  type Product,
  type ProductDraft,
  type ProductImage,
  type ProductPublicationInput,
  type ProductSave,
  type ProductSource,
  type ProductSummary,
} from '../contracts.js'
import { PluginFailure, cancelled, invalidRequest, timedOut } from '../domain/errors.js'
import { decodeImageChunk } from '../domain/images.js'
import { parseProductImport } from '../domain/import.js'
import { latestPublication, publicationListingKey } from '../domain/publications.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type {
  AssertAlive,
  ProductsStore,
  StoreDocument,
  StoredProduct,
} from '../store/private-store.js'

export const UPLOAD_TTL_MS = 5 * 60_000
const MAX_UPLOADS = 4

interface Upload {
  mime: ProductImage['mime']
  size: number
  received: number
  expiresAt: number
  chunks: Buffer[]
  finishing: boolean
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success)
    throw invalidRequest(
      `商品参数无效：${parsed.error.issues[0]?.message ?? '字段格式错误'}`.slice(0, 500),
    )
  return parsed.data
}

function findProduct(document: StoreDocument, id: string): StoredProduct {
  const product = document.products.find((entry) => entry.id === id)
  if (!product) throw invalidRequest('商品不存在或已删除，请重新读取列表')
  return product
}

function assertRevision(product: StoredProduct, revision: number): void {
  if (product.revision !== revision)
    throw invalidRequest('商品已被其他操作修改，请重新读取后再保存或删除')
}

function pruneImages(document: StoreDocument, candidates: Set<string>): void {
  const referenced = new Set(
    document.products.flatMap((product) => product.images.map((image) => image.id)),
  )
  document.images = document.images.filter(
    (image) => !candidates.has(image.id) || referenced.has(image.id),
  )
}

function publicProduct(product: StoredProduct): Product {
  const { publications, ...data } = product
  return {
    ...data,
    publicationCount: publications.length,
    latestPublication: latestPublication(publications),
  }
}

function summary(product: StoredProduct): ProductSummary {
  const projected = publicProduct(product)
  return {
    id: projected.id,
    revision: projected.revision,
    sequence: projected.sequence,
    name: projected.name,
    title: projected.title,
    sku: projected.sku,
    price: projected.price,
    currency: projected.currency,
    category: projected.category,
    status: projected.status,
    createdAt: projected.createdAt,
    updatedAt: projected.updatedAt,
    publicationCount: projected.publicationCount,
    latestPublication: projected.latestPublication,
    source: { kind: projected.source.kind },
    cover: projected.images[0] ?? null,
    imageCount: projected.images.length,
  }
}

function productFields(data: ProductDraft): Omit<ProductDraft, 'imageIds'> {
  const result = { ...data }
  Reflect.deleteProperty(result, 'imageIds')
  return result
}
export interface ProductsServiceOptions {
  store: ProductsStore
  now?: () => Date
}

export class ProductsService {
  private readonly store: ProductsStore
  private readonly now: () => Date
  private readonly uploads = new Map<string, Upload>()
  private stopped = false

  constructor(options: ProductsServiceOptions) {
    this.store = options.store
    this.now = options.now ?? (() => new Date())
  }

  status(): Record<string, unknown> {
    return { storageDurable: this.store.durable }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.uploads.clear()
  }

  async call(context: DispatchContext): Promise<unknown> {
    const assertAlive = () => {
      context.assertAlive()
      if (context.signal?.aborted || this.stopped) throw cancelled()
      if (Date.now() >= context.deadlineAt) throw timedOut()
    }
    assertAlive()
    if (context.capability !== PRODUCT_CAPABILITY)
      throw new PluginFailure('PERMISSION_DENIED', '商品插件未声明此能力')
    switch (context.method) {
      case 'products.list': {
        const input = parseInput(ProductQuerySchema, context.payload)
        const document = await this.store.read()
        assertAlive()
        const query = input.query.toLowerCase()
        const products = document.products
          .filter(
            (product) =>
              (!input.status || product.status === input.status) &&
              (!input.sourceKind || product.source.kind === input.sourceKind) &&
              (!input.publicationStatus ||
                (input.publicationStatus === 'published'
                  ? product.publications.length > 0
                  : product.publications.length === 0)) &&
              (!query ||
                [
                  product.name,
                  product.title,
                  product.description,
                  product.sku,
                  product.category,
                  product.condition,
                  product.brand,
                  product.size,
                  product.note,
                  ...product.tags,
                  ...product.publications.flatMap((publication) => [
                    publication.windowName,
                    publication.windowId,
                    publication.listingId,
                    publication.platform,
                  ]),
                ]
                  .join('\n')
                  .toLowerCase()
                  .includes(query)),
          )
          .sort((a, b) => b.sequence - a.sequence)
        const page = Math.min(
          input.page,
          Math.max(1, Math.ceil(products.length / input.pageSize)),
        )
        return {
          items: products
            .slice((page - 1) * input.pageSize, page * input.pageSize)
            .map(summary),
          total: products.length,
          page,
          pageSize: input.pageSize,
          storageDurable: this.store.durable,
        }
      }
      case 'products.get': {
        const { id } = parseInput(ProductGetSchema, context.payload)
        const product = findProduct(await this.store.read(), id)
        await this.checkImages(
          product.images.map((image) => image.id),
          assertAlive,
        )
        assertAlive()
        return { product: publicProduct(product) }
      }
      case 'products.save':
        return this.save(parseInput(ProductSaveSchema, context.payload), assertAlive)
      case 'products.publications.record':
        return this.recordPublication(
          parseInput(ProductPublicationInputSchema, context.payload),
          assertAlive,
        )
      case 'products.publications.list': {
        const input = parseInput(ProductPublicationQuerySchema, context.payload)
        const product = findProduct(await this.store.read(), input.productId)
        assertAlive()
        const publications = [...product.publications].sort((left, right) =>
          compareProductPublicationRecency(right, left),
        )
        const page = Math.min(
          input.page,
          Math.max(1, Math.ceil(publications.length / input.pageSize)),
        )
        return {
          productId: product.id,
          productName: product.name,
          productRevision: product.revision,
          items: publications.slice((page - 1) * input.pageSize, page * input.pageSize),
          total: publications.length,
          page,
          pageSize: input.pageSize,
        }
      }
      case 'products.remove': {
        const { id, expectedRevision } = parseInput(ProductRemoveSchema, context.payload)
        return this.store.mutate((document) => {
          assertAlive()
          const product = document.products.find((entry) => entry.id === id)
          if (!product) return { id, removed: false }
          assertRevision(product, expectedRevision)
          document.products = document.products.filter((entry) => entry.id !== id)
          pruneImages(document, new Set(product.images.map((image) => image.id)))
          return { id, removed: true }
        }, assertAlive)
      }
      case 'products.import': {
        const { format, content } = parseInput(ProductImportSchema, context.payload)
        const parsed = parseProductImport(format, content)
        return this.store.mutate(async (document) => {
          assertAlive()
          const report = structuredClone(parsed.report)
          const receipts = new Set(
            document.receipts
              .filter((entry) => entry.kind === 'import')
              .map((entry) => entry.key),
          )
          for (const row of parsed.rows) {
            assertAlive()
            if (receipts.has(row.key)) {
              report.skipped++
              continue
            }
            await this.create(
              document,
              row.data,
              { kind: 'import', key: row.key },
              assertAlive,
              {
                kind: 'import',
                key: row.key,
              },
            )
            receipts.add(row.key)
            report.inserted++
          }
          return report
        }, assertAlive)
      }
      case 'products.sources.find': {
        const { recordId } = parseInput(ProductSourceFindSchema, context.payload)
        const document = await this.store.read()
        const receipt = document.receipts.find(
          (entry) => entry.kind === 'ai' && entry.key === recordId,
        )
        const product = receipt
          ? (document.products.find((entry) => entry.id === receipt.productId) ?? null)
          : null
        if (product)
          await this.checkImages(
            product.images.map((image) => image.id),
            assertAlive,
          )
        assertAlive()
        return { product: product ? publicProduct(product) : null }
      }
      case 'products.importAi': {
        const input = parseInput(ProductImportAiSchema, context.payload)
        return this.store.mutate(async (document) => {
          assertAlive()
          const existing = this.receiptProduct(document, 'ai', input.recordId)
          if (existing) {
            await this.checkImages(
              existing.images.map((image) => image.id),
              assertAlive,
            )
            return { product: publicProduct(existing), alreadyImported: true }
          }
          const product = await this.create(
            document,
            input.data,
            {
              kind: 'ai-image',
              recordId: input.recordId,
              origin: input.origin,
            },
            assertAlive,
            { kind: 'ai', key: input.recordId },
          )
          return { product: publicProduct(product), alreadyImported: false }
        }, assertAlive)
      }
      case 'products.upload.begin': {
        const input = parseInput(UploadBeginSchema, context.payload)
        this.expireUploads()
        if (this.uploads.size >= MAX_UPLOADS)
          throw new PluginFailure('RATE_LIMITED', '最多同时上传四张图片，请稍后重试')
        const uploadId = randomUUID()
        assertAlive()
        this.uploads.set(uploadId, {
          ...input,
          received: 0,
          chunks: [],
          expiresAt: this.now().getTime() + UPLOAD_TTL_MS,
          finishing: false,
        })
        return { uploadId, chunkSize: IMAGE_CHUNK_BYTES }
      }
      case 'products.upload.chunk': {
        const input = parseInput(UploadChunkSchema, context.payload)
        const upload = this.upload(input.uploadId)
        if (upload.finishing) throw invalidRequest('图片正在提交，不能追加分块')
        if (input.index !== upload.chunks.length) throw invalidRequest('图片分块顺序错误')
        const bytes = decodeImageChunk(input.data)
        if (bytes.length !== Math.min(IMAGE_CHUNK_BYTES, upload.size - upload.received))
          throw invalidRequest('图片分块长度与声明不符')
        assertAlive()
        upload.chunks.push(bytes)
        upload.received += bytes.length
        return { accepted: true }
      }
      case 'products.upload.finish': {
        const input = parseInput(UploadFinishSchema, context.payload)
        this.expireUploads()
        const pending = this.uploads.get(input.uploadId)
        const recoverGuard = () => {
          assertAlive()
          if (pending && this.uploads.get(input.uploadId) !== pending)
            throw cancelled('图片上传已取消或过期')
        }
        const recovered = await this.store.mutate(async (document) => {
          const receipt = document.uploadReceipts.find(
            (entry) => entry.uploadId === input.uploadId,
          )
          if (receipt)
            return (await this.store.readImage(receipt.imageId, assertAlive)).image
          recoverGuard()
          return null
        }, assertAlive)
        if (recovered) return { image: recovered }
        const upload = this.upload(input.uploadId)
        if (upload.finishing) throw invalidRequest('图片正在提交，请等待完成')
        if (upload.received !== upload.size) throw invalidRequest('图片尚未上传完整')
        assertAlive()
        upload.finishing = true
        const guard = () => {
          assertAlive()
          if (
            this.uploads.get(input.uploadId) !== upload ||
            this.now().getTime() >= upload.expiresAt
          )
            throw cancelled('图片上传已取消或过期')
        }
        try {
          const image = await this.store.putImage(
            Buffer.concat(upload.chunks),
            { mime: upload.mime, name: input.name, uploadId: input.uploadId },
            guard,
          )
          this.uploads.delete(input.uploadId)
          return { image }
        } finally {
          upload.finishing = false
        }
      }
      case 'products.upload.abort': {
        const { uploadId } = parseInput(UploadAbortSchema, context.payload)
        this.expireUploads()
        assertAlive()
        const active = this.uploads.delete(uploadId)
        return this.store.mutate((document) => {
          const receipt = document.uploadReceipts.find(
            (entry) => entry.uploadId === uploadId,
          )
          if (!receipt) return { aborted: active }
          pruneImages(document, new Set([receipt.imageId]))
          document.uploadReceipts = document.uploadReceipts.filter(
            (entry) => entry.uploadId !== uploadId,
          )
          return { aborted: true }
        }, assertAlive)
      }
      case 'products.images.read': {
        const input = parseInput(ImageReadSchema, context.payload)
        const { bytes } = await this.store.readImage(input.imageId, assertAlive)
        if (input.offset > bytes.length) throw invalidRequest('图片读取偏移超过文件长度')
        const end = Math.min(bytes.length, input.offset + input.length)
        assertAlive()
        return {
          data: bytes.subarray(input.offset, end).toString('base64'),
          next: end,
          done: end === bytes.length,
          total: bytes.length,
        }
      }
      case 'products.images.discard': {
        const { ids } = parseInput(ImageDiscardSchema, context.payload)
        return this.store.mutate((document) => {
          assertAlive()
          const previous = document.images.length
          pruneImages(document, new Set(ids))
          return { removed: previous - document.images.length }
        }, assertAlive)
      }
      default:
        throw invalidRequest('商品插件不支持此方法')
    }
  }

  private recordPublication(input: ProductPublicationInput, assertAlive: AssertAlive) {
    return this.store.mutate((document) => {
      assertAlive()
      const receipt = document.publicationReceipts.find(
        (entry) => entry.publication.operationId === input.operationId,
      )
      if (receipt) {
        if (
          receipt.productId !== input.productId ||
          (
            [
              'windowId',
              'windowName',
              'platform',
              'listingId',
              'listingUrl',
              'productRevision',
              'publishedAt',
            ] as const
          ).some((key) => receipt.publication[key] !== input[key])
        )
          throw invalidRequest('发布操作标识已用于不同的商品或发布结果')
        return {
          product: publicProduct(findProduct(document, input.productId)),
          alreadyRecorded: true,
        }
      }
      const product = findProduct(document, input.productId)
      if (input.productRevision > product.revision)
        throw invalidRequest('发布快照修订号不能超过当前商品修订号')
      const listing = publicationListingKey(input)
      if (
        document.publicationReceipts.some(
          (entry) => publicationListingKey(entry.publication) === listing,
        )
      )
        throw invalidRequest('此平台和窗口的刊登结果已登记，不能使用新操作重复登记')
      const timestamp = this.now().toISOString()
      const publication = {
        ...input,
        id: randomUUID(),
        recordedAt: timestamp,
      }
      Reflect.deleteProperty(publication, 'productId')
      product.publications.push(publication)
      product.revision++
      product.updatedAt = timestamp
      // The receipt survives deletion and commits with the product history.
      document.publicationReceipts.push({ productId: product.id, publication })
      return { product: publicProduct(product), alreadyRecorded: false }
    }, assertAlive)
  }

  private save(input: ProductSave, assertAlive: AssertAlive) {
    return this.store.mutate(async (document) => {
      assertAlive()
      if (!input.id) {
        const existing = this.receiptProduct(document, 'create', input.createKey!)
        if (existing) {
          await this.checkImages(
            existing.images.map((image) => image.id),
            assertAlive,
          )
          return { product: publicProduct(existing), alreadySaved: true }
        }
        const product = await this.create(
          document,
          input.data,
          { kind: 'manual' },
          assertAlive,
          {
            kind: 'create',
            key: input.createKey!,
          },
        )
        return { product: publicProduct(product), alreadySaved: false }
      }
      const previous = findProduct(document, input.id)
      assertRevision(previous, input.expectedRevision!)
      const images = await this.checkImages(input.data.imageIds, assertAlive)
      const product: StoredProduct = {
        ...previous,
        ...productFields(input.data),
        images,
        revision: previous.revision + 1,
        updatedAt: this.now().toISOString(),
      }
      document.products[document.products.findIndex((entry) => entry.id === input.id)] =
        product
      pruneImages(document, new Set(previous.images.map((image) => image.id)))
      return { product: publicProduct(product), alreadySaved: false }
    }, assertAlive)
  }

  private async create(
    document: StoreDocument,
    data: ProductDraft,
    source: ProductSource,
    assertAlive: AssertAlive,
    receipt: { kind: 'create' | 'ai' | 'import'; key: string },
  ): Promise<StoredProduct> {
    const images = await this.checkImages(data.imageIds, assertAlive)
    assertAlive()
    const timestamp = this.now().toISOString()
    const product: StoredProduct = {
      ...productFields(data),
      id: randomUUID(),
      revision: 1,
      sequence: document.nextSequence++,
      images,
      publications: [],
      source,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    document.products.push(product)
    document.receipts.push({ ...receipt, productId: product.id })
    return product
  }

  private receiptProduct(
    document: StoreDocument,
    kind: 'create' | 'ai',
    key: string,
  ): StoredProduct | null {
    const receipt = document.receipts.find(
      (entry) => entry.kind === kind && entry.key === key,
    )
    if (!receipt) return null
    const product = document.products.find((entry) => entry.id === receipt.productId)
    if (!product) throw invalidRequest('此请求对应的商品已删除，不能重建或返回已成功')
    return product
  }

  private async checkImages(
    ids: string[],
    assertAlive: AssertAlive,
  ): Promise<ProductImage[]> {
    const images: ProductImage[] = []
    for (const id of ids) {
      assertAlive()
      images.push((await this.store.readImage(id, assertAlive)).image)
    }
    assertAlive()
    return images
  }

  private expireUploads(): void {
    const now = this.now().getTime()
    for (const [id, upload] of this.uploads)
      if (now >= upload.expiresAt) this.uploads.delete(id)
  }

  private upload(id: string): Upload {
    this.expireUploads()
    const upload = this.uploads.get(id)
    if (!upload) throw invalidRequest('图片上传不存在、已取消或已过期，请重新上传')
    return upload
  }
}
