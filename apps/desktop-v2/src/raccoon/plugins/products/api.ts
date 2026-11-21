import { invoke } from '@tauri-apps/api/core'
import {
  PRODUCTS_PLUGIN_ID,
  PRODUCT_CAPABILITY,
  ProductGetSchema,
  ProductImportReportSchema,
  ProductImportSchema,
  ProductPageSchema,
  ProductPublicationPageSchema,
  ProductPublicationQuerySchema,
  ProductPublicationSchema,
  ProductQuerySchema,
  ProductRemoveReplySchema,
  ProductRemoveSchema,
  ProductReplySchema,
  ProductSaveReplySchema,
  ProductSaveSchema,
  type Product,
  type ProductPage,
  type ProductPublication,
  type ProductPublicationPage,
  type ProductPublicationQuery,
  type ProductQuery,
  type ProductSave,
} from '@nexus/plugin-contracts/products'
import { callPlugin } from '../call'
import type { PluginView } from '../types'

export const productFeatures = {
  list: ['products.list'],
  edit: ['products.get', 'products.save'],
  images: [
    'products.images.read',
    'products.images.discard',
    'products.upload.begin',
    'products.upload.chunk',
    'products.upload.finish',
    'products.upload.abort',
  ],
  import: ['products.import'],
  remove: ['products.remove'],
  history: ['products.publications.list'],
  importAi: ['products.sources.find', 'products.importAi'],
} as const

export function supportsProductPage(plugin: PluginView | undefined) {
  return (['list', 'edit', 'images', 'import', 'remove', 'history'] as const).every(
    (feature) => supportsProduct(plugin, feature),
  )
}

export async function openPublication(publication: ProductPublication) {
  const { listingUrl } = ProductPublicationSchema.parse(publication)
  return invoke<void>('external_url_open', { url: listingUrl })
}

export function supportsProduct(
  plugin: PluginView | undefined,
  feature: keyof typeof productFeatures,
) {
  return Boolean(
    plugin?.id === PRODUCTS_PLUGIN_ID &&
    plugin.enabled &&
    plugin.state === 'running' &&
    plugin.capabilities.includes(PRODUCT_CAPABILITY) &&
    plugin.granted.includes(PRODUCT_CAPABILITY) &&
    productFeatures[feature].every((method) => plugin.methods.includes(method)),
  )
}

type ProductUiMethod = (typeof productFeatures)[keyof typeof productFeatures][number]

export function callProducts(
  method: ProductUiMethod,
  payload: unknown,
): Promise<unknown> {
  return callPlugin(
    PRODUCTS_PLUGIN_ID,
    PRODUCT_CAPABILITY,
    method,
    payload,
    (value) => value,
  )
}

function validPage(
  result: ProductPage | ProductPublicationPage,
  input: { page: number; pageSize: number },
) {
  const page = Math.min(input.page, Math.max(1, Math.ceil(result.total / input.pageSize)))
  return (
    result.page === page &&
    result.pageSize === input.pageSize &&
    result.items.length ===
      Math.min(input.pageSize, result.total - (page - 1) * input.pageSize) &&
    new Set(result.items.map((item) => item.id)).size === result.items.length
  )
}

function publicationMatches(
  product: Pick<Product, 'publicationCount' | 'latestPublication' | 'revision'>,
) {
  return (
    (product.publicationCount === 0) === (product.latestPublication === null) &&
    (product.latestPublication?.productRevision ?? 0) <= product.revision
  )
}

function validProduct(product: Product) {
  return (
    publicationMatches(product) &&
    new Set(product.images.map((image) => image.id)).size === product.images.length
  )
}

function comparePublications(left: ProductPublication, right: ProductPublication) {
  const seconds = (value: string) => Date.parse(value.replace(/\.\d+Z$/, 'Z'))
  const fraction = (value: string) =>
    (value.match(/\.(\d+)Z$/)?.[1] ?? '').replace(/0+$/, '')
  const difference = seconds(left.publishedAt) - seconds(right.publishedAt)
  const leftFraction = fraction(left.publishedAt)
  const rightFraction = fraction(right.publishedAt)
  return (
    difference ||
    (leftFraction === rightFraction ? 0 : leftFraction > rightFraction ? 1 : -1) ||
    (left.id === right.id ? 0 : left.id > right.id ? 1 : -1)
  )
}

function stableFields(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) => {
    if (field === null || typeof field !== 'object' || Array.isArray(field)) return field
    return Object.fromEntries(
      Object.entries(field).sort(([left], [right]) => left.localeCompare(right)),
    )
  })
}

export const productApi = {
  async list(query: Partial<ProductQuery>) {
    const input = ProductQuerySchema.parse(query)
    const result = ProductPageSchema.parse(await callProducts('products.list', input))
    if (
      !validPage(result, input) ||
      result.items.some(
        (item) =>
          !publicationMatches(item) ||
          (item.imageCount === 0) !== (item.cover === null) ||
          (input.status !== undefined && item.status !== input.status) ||
          (input.sourceKind !== undefined && item.source.kind !== input.sourceKind) ||
          (input.publicationStatus !== undefined &&
            item.publicationCount > 0 !== (input.publicationStatus === 'published')),
      )
    )
      throw new Error('商品插件返回的分页资料不一致，请刷新后重试。')
    return result
  },

  async get(id: string) {
    const input = ProductGetSchema.parse({ id })
    const { product } = ProductReplySchema.parse(
      await callProducts('products.get', input),
    )
    if (product.id !== input.id || !validProduct(product))
      throw new Error('商品详情与请求不一致，请刷新后重试。')
    return product
  },

  async save(draft: ProductSave) {
    const input = ProductSaveSchema.parse(draft)
    const { product, alreadySaved } = ProductSaveReplySchema.parse(
      await callProducts('products.save', input),
    )
    if (
      !validProduct(product) ||
      (input.id
        ? alreadySaved ||
          product.id !== input.id ||
          product.revision !== (input.expectedRevision ?? 0) + 1
        : product.source.kind !== 'manual' || (!alreadySaved && product.revision !== 1))
    )
      throw new Error('商品保存结果不一致，请刷新确认后再编辑。')
    const { imageIds, ...fields } = input.data
    if (
      stableFields(imageIds) !== stableFields(product.images.map((image) => image.id)) ||
      (Object.keys(fields) as (keyof typeof fields)[]).some(
        (key) => stableFields(fields[key]) !== stableFields(product[key]),
      )
    )
      throw new Error(
        alreadySaved
          ? '此请求已创建商品，但资料与当前表单不同。请从列表确认。'
          : '商品保存结果与表单不一致，请刷新确认。',
      )
    return product
  },

  async remove(product: Pick<Product, 'id' | 'revision'>) {
    const input = ProductRemoveSchema.parse({
      id: product.id,
      expectedRevision: product.revision,
    })
    const result = ProductRemoveReplySchema.parse(
      await callProducts('products.remove', input),
    )
    if (result.id !== input.id) throw new Error('商品删除结果不一致，请刷新确认。')
    return result.removed
  },

  async import(format: 'csv' | 'json', content: string) {
    const input = ProductImportSchema.parse({ format, content })
    if (new TextEncoder().encode(content).byteLength > 512 * 1024)
      throw new Error('导入内容不能超过 512 KiB。')
    const result = ProductImportReportSchema.parse(
      await callProducts('products.import', input),
    )
    if (
      result.total !== result.inserted + result.skipped ||
      result.errors.length > result.skipped ||
      new Set(result.errors.map((row) => row.row)).size !== result.errors.length
    )
      throw new Error('商品导入结果不完整，请刷新列表确认。')
    return result
  },

  async listPublications(
    query: Pick<ProductPublicationQuery, 'productId'> & Partial<ProductPublicationQuery>,
  ) {
    const input = ProductPublicationQuerySchema.parse(query)
    const result = ProductPublicationPageSchema.parse(
      await callProducts('products.publications.list', input),
    )
    if (
      result.productId !== input.productId ||
      !validPage(result, input) ||
      result.items.some(
        (entry, index) =>
          entry.productRevision > result.productRevision ||
          (index > 0 && comparePublications(result.items[index - 1]!, entry) < 0),
      )
    )
      throw new Error('发布历史的分页资料不一致，请刷新重试。')
    return result
  },
}
