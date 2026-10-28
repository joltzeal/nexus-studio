import type { AiImageHandoff, GenerationSource } from '@/lib/page-handoff'
import { VINTED_PLUGIN_ID, type Item } from './types'

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
