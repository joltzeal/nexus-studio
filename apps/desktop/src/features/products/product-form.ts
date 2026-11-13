import type {
  Product,
  ProductDraft,
  ProductSave,
  ProductSource,
  ProductStatus,
} from '@nexus/plugin-products/contracts'

export type ProductForm = Omit<ProductDraft, 'price' | 'tags' | 'imageIds'> & {
  price: string
  tags: string
}

export const PRODUCT_STATUS_OPTIONS: { value: ProductStatus; label: string }[] = [
  { value: 'draft', label: '草稿' },
  { value: 'ready', label: '待上架' },
  { value: 'archived', label: '已归档' },
]

export const PRODUCT_SOURCE_OPTIONS: { value: ProductSource['kind']; label: string }[] = [
  { value: 'manual', label: '手动创建' },
  { value: 'import', label: '文件导入' },
  { value: 'ai-image', label: 'AI 生图' },
]

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
  }
}

export function productForm(product: Product): ProductForm {
  return {
    name: product.name,
    title: product.title,
    description: product.description,
    sku: product.sku,
    price: product.price === null ? '' : String(product.price),
    currency: product.currency,
    category: product.category,
    condition: product.condition,
    brand: product.brand,
    size: product.size,
    tags: product.tags.join(', '),
    note: product.note,
    status: product.status,
  }
}

export function productSaveInput(
  form: ProductForm,
  imageIds: string[],
  identity: { createKey: string } | { id: string; expectedRevision: number },
  originalTags: string[] = [],
): ProductSave {
  const price = form.price.trim() === '' ? null : Number(form.price)
  if (price !== null && !Number.isFinite(price)) throw new Error('请输入有效价格。')
  return {
    ...identity,
    data: {
      ...form,
      price,
      tags:
        form.tags === originalTags.join(', ')
          ? [...originalTags]
          : form.tags
              .split(/[,，\n]/)
              .map((tag) => tag.trim())
              .filter(Boolean),
      imageIds,
    },
  }
}

export function productError(cause: unknown): string {
  if (
    cause instanceof Error &&
    cause.name === 'ZodError' &&
    'issues' in cause &&
    Array.isArray(cause.issues)
  ) {
    const labels: Record<string, string> = {
      name: '商品名称',
      title: '英文标题',
      description: '英文描述',
      sku: 'SKU',
      price: '价格',
      currency: '币种',
      category: '分类',
      condition: '成色',
      brand: '品牌',
      size: '尺码 / 尺寸',
      tags: '标签',
      note: '内部备注',
      status: '商品状态',
      imageIds: '商品图片',
      expectedRevision: '商品修订号',
      createKey: '创建请求标识',
    }
    const hints: string[] = []
    for (const issue of cause.issues) {
      if (typeof issue !== 'object' || issue === null) continue
      const path = 'path' in issue && Array.isArray(issue.path) ? issue.path : []
      const field = [...path]
        .reverse()
        .find((entry) => typeof entry === 'string' && labels[entry])
      const label = typeof field === 'string' ? labels[field] : undefined
      const message =
        'message' in issue && typeof issue.message === 'string' ? issue.message : ''
      const hint = /[\u4e00-\u9fff]/.test(message) ? message : '格式不正确，请检查后重试'
      hints.push(
        label ? `${label}：${hint}` : '商品资料格式不正确，请检查输入或更新插件后重试。',
      )
    }
    return [...new Set(hints)].join('；') || '商品资料校验失败，请检查输入后重试。'
  }
  return cause instanceof Error ? cause.message : '商品操作失败，请重试。'
}

export function productPrice(product: { price: number | null; currency: string }) {
  if (product.price === null) return '未填写'
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: product.currency,
  }).format(product.price)
}

export function productTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
