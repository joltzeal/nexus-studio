import { z } from 'zod'

export const PRODUCTS_PLUGIN_ID = 'studio.products'
export const PRODUCT_CAPABILITY = 'product.catalog'
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const IMAGE_CHUNK_BYTES = 192 * 1024
export const MAX_PRODUCT_IMAGES = 12

export const PRODUCT_METHODS = [
  'products.list',
  'products.get',
  'products.save',
  'products.publications.record',
  'products.publications.list',
  'products.remove',
  'products.import',
  'products.sources.find',
  'products.importAi',
  'products.upload.begin',
  'products.upload.chunk',
  'products.upload.finish',
  'products.upload.abort',
  'products.images.read',
  'products.images.discard',
] as const

export const ProductStatusSchema = z.enum(['draft', 'ready', 'archived'])
export const CurrencySchema = z.enum(['USD', 'GBP', 'EUR'])
export const ImageMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp'])
const uniqueIds = z
  .array(z.uuid())
  .max(MAX_PRODUCT_IMAGES)
  .refine((ids) => new Set(ids).size === ids.length, '图片不能重复')

const fields = z.strictObject({
  name: z.string().trim().min(1).max(200),
  title: z.string().trim().max(500).default(''),
  description: z.string().trim().max(6000).default(''),
  sku: z.string().trim().max(80).default(''),
  price: z.number().finite().positive().max(100_000_000).nullable().default(null),
  currency: CurrencySchema.default('USD'),
  category: z.string().trim().max(200).default(''),
  condition: z.string().trim().max(120).default(''),
  brand: z.string().trim().max(120).default(''),
  size: z.string().trim().max(120).default(''),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  note: z.string().trim().max(2000).default(''),
  status: ProductStatusSchema.default('draft'),
})

export const ProductDraftSchema = fields
  .extend({ imageIds: uniqueIds.default([]) })
  .superRefine((product, context) => {
    if (product.status !== 'ready') return
    for (const key of ['title', 'description', 'condition'] as const) {
      if (!product[key])
        context.addIssue({
          code: 'custom',
          path: [key],
          message: '待上架商品的必需资料尚未完整',
        })
    }
    if (product.price === null)
      context.addIssue({ code: 'custom', path: ['price'], message: '请填写价格' })
    if (!product.imageIds.length)
      context.addIssue({
        code: 'custom',
        path: ['imageIds'],
        message: '请至少添加一张图片',
      })
  })

export const ProductImageSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(200),
  mime: ImageMimeSchema,
  bytes: z.number().int().min(1).max(MAX_IMAGE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})

export const GenerationOriginSchema = z.strictObject({
  pluginId: z.string().trim().min(1).max(253),
  itemId: z.string().trim().min(1).max(200),
  title: z.string().max(500),
  url: z.string().max(2048),
})

export const ProductSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({ kind: z.literal('import'), key: z.string().min(1).max(128) }),
  z.strictObject({
    kind: z.literal('ai-image'),
    recordId: z.string().trim().min(1).max(128),
    origin: GenerationOriginSchema.nullable(),
  }),
])

const publicationText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0)

const publicationFields = z.strictObject({
  operationId: z.uuid(),
  windowId: z.uuid(),
  windowName: publicationText(200),
  platform: publicationText(80),
  listingId: publicationText(200),
  listingUrl: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .refine((value) => {
      if (!/^https?:\/\//i.test(value.trim())) return false
      if (/[\ud800-\udfff]/u.test(value)) return false
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index)
        if (code < 32 || code === 127 || code === 92) return false
      }
      try {
        const url = new URL(value)
        return !!url.hostname && !url.username && !url.password
      } catch {
        return false
      }
    }),
  productRevision: z.number().int().min(1),
  publishedAt: z.iso.datetime().max(64),
})

export const ProductPublicationSchema = publicationFields.extend({
  id: z.uuid(),
  recordedAt: z.iso.datetime().max(64),
})

export const ProductPublicationInputSchema = publicationFields.extend({
  productId: z.uuid(),
})

export const ProductSchema = fields.extend({
  id: z.uuid(),
  revision: z.number().int().min(1),
  sequence: z.number().int().min(1),
  images: z.array(ProductImageSchema).max(MAX_PRODUCT_IMAGES),
  publicationCount: z.number().int().min(0),
  latestPublication: ProductPublicationSchema.nullable(),
  source: ProductSourceSchema,
  createdAt: z.iso.datetime().max(64),
  updatedAt: z.iso.datetime().max(64),
})

export const ProductSummarySchema = ProductSchema.pick({
  id: true,
  revision: true,
  sequence: true,
  name: true,
  title: true,
  sku: true,
  price: true,
  currency: true,
  category: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  publicationCount: true,
  latestPublication: true,
}).extend({
  source: z.strictObject({ kind: z.enum(['manual', 'import', 'ai-image']) }),
  cover: ProductImageSchema.nullable(),
  imageCount: z.number().int().min(0).max(MAX_PRODUCT_IMAGES),
})

export const ProductPublicationQuerySchema = z.strictObject({
  productId: z.uuid(),
  page: z.number().int().min(1).default(1),
  pageSize: z.union([z.literal(20), z.literal(50)]).default(20),
})

export const ProductPublicationPageSchema = z.strictObject({
  productId: z.uuid(),
  productName: ProductSchema.shape.name,
  productRevision: z.number().int().min(1),
  items: z.array(ProductPublicationSchema).max(50),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.union([z.literal(20), z.literal(50)]),
})

export const ProductQuerySchema = z.strictObject({
  query: z.string().trim().max(200).default(''),
  status: ProductStatusSchema.optional(),
  sourceKind: z.enum(['manual', 'import', 'ai-image']).optional(),
  publicationStatus: z.enum(['published', 'unpublished']).optional(),
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.union([z.literal(20), z.literal(50)]).default(20),
})

export const ProductPageSchema = z.strictObject({
  items: z.array(ProductSummarySchema).max(50),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.union([z.literal(20), z.literal(50)]),
  storageDurable: z.boolean(),
})

export const ProductSaveSchema = z
  .strictObject({
    id: z.uuid().optional(),
    expectedRevision: z.number().int().min(1).optional(),
    createKey: z.uuid().optional(),
    data: ProductDraftSchema,
  })
  .superRefine((input, context) => {
    if (input.id && input.expectedRevision === undefined)
      context.addIssue({
        code: 'custom',
        path: ['expectedRevision'],
        message: '缺少商品修订号',
      })
    if (!input.id && !input.createKey)
      context.addIssue({
        code: 'custom',
        path: ['createKey'],
        message: '缺少创建请求标识',
      })
    if (input.id && input.createKey)
      context.addIssue({
        code: 'custom',
        path: ['createKey'],
        message: '编辑不能带创建请求标识',
      })
  })

export const ProductGetSchema = z.strictObject({ id: z.uuid() })
export const ProductRemoveSchema = ProductGetSchema.extend({
  expectedRevision: z.number().int().min(1),
})
export const ProductImportSchema = z.strictObject({
  format: z.enum(['csv', 'json']),
  content: z
    .string()
    .min(1)
    .max(512 * 1024),
})
export const ProductImportReportSchema = z.strictObject({
  total: z.number().int().min(0),
  inserted: z.number().int().min(0),
  skipped: z.number().int().min(0),
  errors: z
    .array(
      z.strictObject({
        row: z.number().int().min(1),
        message: z.string().max(500),
      }),
    )
    .max(1000),
})
export const ProductSourceFindSchema = z.strictObject({
  recordId: z.string().trim().min(1).max(128),
})
export const ProductImportAiSchema = ProductSourceFindSchema.extend({
  origin: GenerationOriginSchema.nullable().default(null),
  data: ProductDraftSchema,
}).refine((input) => input.data.imageIds.length > 0, '请复制至少一张生图成片')

export const UploadBeginSchema = z.strictObject({
  mime: ImageMimeSchema,
  size: z.number().int().min(1).max(MAX_IMAGE_BYTES),
})
export const UploadChunkSchema = z.strictObject({
  uploadId: z.uuid(),
  index: z.number().int().min(0),
  data: z
    .string()
    .min(1)
    .max(Math.ceil(IMAGE_CHUNK_BYTES / 3) * 4),
})
export const UploadFinishSchema = z.strictObject({
  uploadId: z.uuid(),
  name: z.string().trim().min(1).max(200),
})
export const UploadAbortSchema = z.strictObject({ uploadId: z.uuid() })
export const ImageReadSchema = z.strictObject({
  imageId: z.uuid(),
  offset: z.number().int().min(0).max(MAX_IMAGE_BYTES),
  length: z.number().int().min(1).max(IMAGE_CHUNK_BYTES).default(IMAGE_CHUNK_BYTES),
})
export const ImageDiscardSchema = z.strictObject({
  ids: z
    .array(z.uuid())
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length),
})
export const ImageChunkSchema = z.strictObject({
  data: z.string().max(Math.ceil(IMAGE_CHUNK_BYTES / 3) * 4),
  next: z.number().int().min(0).max(MAX_IMAGE_BYTES),
  done: z.boolean(),
  total: z.number().int().min(1).max(MAX_IMAGE_BYTES),
})

export const ProductReplySchema = z.strictObject({ product: ProductSchema })
export const ProductSaveReplySchema = ProductReplySchema.extend({
  alreadySaved: z.boolean(),
})
export const ProductPublicationReplySchema = ProductReplySchema.extend({
  alreadyRecorded: z.boolean(),
})
export const ProductSourceReplySchema = z.strictObject({
  product: ProductSchema.nullable(),
})
export const ProductAiReplySchema = ProductReplySchema.extend({
  alreadyImported: z.boolean(),
})
export const ProductRemoveReplySchema = z.strictObject({
  id: z.uuid(),
  removed: z.boolean(),
})
export const UploadBeginReplySchema = z.strictObject({
  uploadId: z.uuid(),
  chunkSize: z.number().int().min(1).max(IMAGE_CHUNK_BYTES),
})
export const UploadChunkReplySchema = z.strictObject({ accepted: z.literal(true) })
export const UploadFinishReplySchema = z.strictObject({ image: ProductImageSchema })
export const UploadAbortReplySchema = z.strictObject({ aborted: z.boolean() })
export const ImageDiscardReplySchema = z.strictObject({
  removed: z.number().int().min(0).max(100),
})

export type Product = z.infer<typeof ProductSchema>
export type ProductPublication = z.infer<typeof ProductPublicationSchema>
export type ProductPublicationInput = z.infer<typeof ProductPublicationInputSchema>
export type ProductPublicationQuery = z.infer<typeof ProductPublicationQuerySchema>
export type ProductPublicationPage = z.infer<typeof ProductPublicationPageSchema>
export type ProductSummary = z.infer<typeof ProductSummarySchema>
export type ProductDraft = z.infer<typeof ProductDraftSchema>
export type ProductImage = z.infer<typeof ProductImageSchema>
export type ProductQuery = z.infer<typeof ProductQuerySchema>
export type ProductPage = z.infer<typeof ProductPageSchema>
export type ProductSave = z.infer<typeof ProductSaveSchema>
export type ProductSource = z.infer<typeof ProductSourceSchema>
export type ProductImportReport = z.infer<typeof ProductImportReportSchema>
export type ProductImportAi = z.infer<typeof ProductImportAiSchema>
export type ProductStatus = z.infer<typeof ProductStatusSchema>

export function compareProductPublicationRecency(
  left: ProductPublication,
  right: ProductPublication,
): number {
  const wholeSeconds = (value: string) => Date.parse(value.replace(/\.\d+Z$/, 'Z'))
  let difference = wholeSeconds(left.publishedAt) - wholeSeconds(right.publishedAt)
  if (difference === 0) {
    // Compare ISO fractions directly; Date.parse can misread long fractions.
    const fraction = (value: string) =>
      (value.match(/\.(\d+)Z$/)?.[1] ?? '').replace(/0+$/, '')
    const leftFraction = fraction(left.publishedAt)
    const rightFraction = fraction(right.publishedAt)
    difference =
      leftFraction === rightFraction ? 0 : leftFraction > rightFraction ? 1 : -1
  }
  if (difference !== 0) return difference
  return left.id === right.id ? 0 : left.id > right.id ? 1 : -1
}
