import type { ProductSource, ProductStatus } from '@nexus/plugin-contracts/products'

export const statusLabels: Record<ProductStatus, string> = {
  draft: '草稿',
  ready: '待上架',
  archived: '已归档',
}

export const sourceLabels: Record<ProductSource['kind'], string> = {
  manual: '手动创建',
  import: '文件导入',
  'ai-image': 'AI 生图',
}

export const publicationLabels = { published: '已发布', unpublished: '未发布' }

export function productTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
