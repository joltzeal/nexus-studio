import type { AiImageHandoff, GenerationSource } from '@/lib/page-handoff'
import { VINTED_PLUGIN_ID, type Item } from './types'
import { safeExternalUrl } from './item-filters'

export function itemReferencePhotos(item: Pick<Item, 'images' | 'imageUrl'>): string[] {
  return [
    ...new Set(
      (item.images?.length ? item.images : [item.imageUrl]).filter(
        (url) => !!safeExternalUrl(url),
      ),
    ),
  ].slice(0, 6)
}

export function itemBatchHandoffs(
  items: readonly Pick<
    Item,
    | 'id'
    | 'title'
    | 'url'
    | 'brand'
    | 'size'
    | 'condition'
    | 'detail'
    | 'images'
    | 'imageUrl'
  >[],
): AiImageHandoff[] {
  const missing = items.filter((item) => itemReferencePhotos(item).length === 0)
  if (missing.length) {
    throw new Error(`${missing.length} 件商品没有可用图片，请取消选择后重试`)
  }
  return items.map((item) => itemAiHandoff(item, itemReferencePhotos(item)))
}

export function vintedItemSource(
  item: Pick<Item, 'id' | 'title' | 'url'>,
): GenerationSource {
  return {
    pluginId: VINTED_PLUGIN_ID,
    itemId: item.id,
    title: item.title || '未命名商品',
    url: item.url,
  }
}

export function itemAiHandoff(
  item: Pick<Item, 'id' | 'title' | 'url' | 'brand' | 'size' | 'condition' | 'detail'>,
  images: readonly string[],
): AiImageHandoff {
  const fields: [string, unknown][] = [
    ['标题', item.title],
    ['品牌', item.brand],
    ['尺码', item.size],
    ['成色', item.condition],
    ['描述', item.detail?.description],
  ]
  const initialPrompt = fields
    .flatMap(([label, value]) =>
      typeof value === 'string' && value.trim() ? [`${label}：${value.trim()}`] : [],
    )
    .join('\n')
  // Keep the full prompt and selection so the editable dialog can report overflow.
  return {
    presentation: 'dialog',
    images: [...images],
    title: item.title,
    source: vintedItemSource(item),
    initialPrompt,
  }
}
