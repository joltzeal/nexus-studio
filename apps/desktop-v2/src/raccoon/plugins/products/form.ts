import {
  ProductSaveSchema,
  type Product,
  type ProductDraft,
  type ProductSave,
} from '@nexus/plugin-contracts/products'

export const productFields = {
  name: '商品名称',
  title: '英文标题',
  description: '英文描述',
  price: '价格',
  currency: '币种',
  category: '分类',
  condition: '成色',
  brand: '品牌',
  size: '尺码 / 尺寸',
  tags: '标签',
  note: '内部备注',
  status: '准备状态',
  imageIds: '商品图片',
  platformFacts: 'Vinted 站点资料',
} as const

export type ProductForm = Omit<
  ProductDraft,
  'price' | 'tags' | 'imageIds' | 'platformFacts'
> & {
  price: string
  tags: string
  sites: {
    platformOrigin: string
    catalogId: string
    catalogRevision: string
    attributes: { name: string; value: string }[]
  }[]
}

export function emptyProductForm(): ProductForm {
  return {
    name: '',
    title: '',
    description: '',
    sku: '',
    price: '',
    currency: 'USD',
    category: '',
    condition: '',
    brand: '',
    size: '',
    tags: '',
    note: '',
    status: 'draft',
    sites: [],
  }
}

export function productForm(product: Product): ProductForm {
  const {
    name,
    title,
    description,
    sku,
    price,
    currency,
    category,
    condition,
    brand,
    size,
    tags,
    note,
    status,
  } = product
  return {
    name,
    title,
    description,
    sku,
    currency,
    category,
    condition,
    brand,
    size,
    note,
    status,
    price: price === null ? '' : String(price),
    tags: tags.join(', '),
    sites: product.platformFacts.vinted.map((site) => ({
      platformOrigin: site.platformOrigin,
      catalogId: site.catalogId === null ? '' : String(site.catalogId),
      catalogRevision: site.catalogRevision ?? '',
      attributes: Object.entries(site.attributes).map(([name, value]) => ({
        name,
        value,
      })),
    })),
  }
}

export function productSaveInput(
  form: ProductForm,
  imageIds: string[],
  identity: { createKey: string } | { id: string; expectedRevision: number },
  originalTags: string[] = [],
): ProductSave {
  const { price, tags, sites, ...fields } = form
  const platformFacts = {
    vinted: sites.map((site) => {
      const catalogId = site.catalogId.trim()
      if (catalogId && !/^[1-9]\d*$/.test(catalogId))
        throw new Error('分类 ID 必须为正整数，或留空。')
      const attributes = new Map<string, string>()
      for (const row of site.attributes) {
        const name = row.name.trim()
        const value = row.value.trim()
        if (!name && !value) continue
        if (!name || !value) throw new Error('请填写完整属性，或移除该行。')
        if (attributes.has(name)) throw new Error('同一站点的属性名称不能重复。')
        attributes.set(name, value)
      }
      return {
        platformOrigin: site.platformOrigin.trim(),
        catalogId: catalogId ? Number(catalogId) : null,
        catalogRevision: site.catalogRevision.trim() || null,
        attributes: Object.fromEntries(attributes),
      }
    }),
  }
  return ProductSaveSchema.parse({
    ...identity,
    data: {
      ...fields,
      imageIds,
      platformFacts,
      price: price.trim() ? Number(price) : null,
      tags:
        tags === originalTags.join(', ')
          ? originalTags
          : tags
              .split(/[,，\n]/)
              .map((tag) => tag.trim())
              .filter(Boolean),
    },
  })
}

export function productError(cause: unknown): string {
  if (
    cause instanceof Error &&
    cause.name === 'ZodError' &&
    'issues' in cause &&
    Array.isArray(cause.issues)
  ) {
    const messages = cause.issues.map((issue: { path?: unknown[]; message?: string }) => {
      const field = issue.path?.find(
        (part) => typeof part === 'string' && Object.hasOwn(productFields, part),
      )
      if (typeof field !== 'string') return '商品资料或插件回执格式无效。'
      const message =
        issue.message && /[\u4e00-\u9fff]/.test(issue.message)
          ? issue.message
          : '请检查格式或补齐资料。'
      return `${productFields[field as keyof typeof productFields]}：${message}`
    })
    return [...new Set(messages)].join('；') || '商品资料校验失败。'
  }
  return cause instanceof Error ? cause.message : '商品操作失败，请重试。'
}
