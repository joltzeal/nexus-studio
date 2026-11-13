import type { PluginView } from '@/lib/platform/native-plugins'
import { AI_IMAGE_CAPABILITY, AI_IMAGE_PLUGIN_ID } from '@/features/ai-image/types'

export function pluginProcessIdentity(plugin: PluginView): string {
  return JSON.stringify([
    plugin.id,
    plugin.version,
    plugin.source,
    plugin.sourceDirectory,
    plugin.status?.pid ?? null,
    plugin.status?.startedAt ?? null,
    plugin.status?.processId ?? null,
    [...plugin.methods].sort(),
  ])
}

export function aiImportUnavailable(plugin: PluginView | null): string | null {
  if (!plugin || plugin.id !== AI_IMAGE_PLUGIN_ID || plugin.state === 'available')
    return 'AI 生图插件尚未安装；仍可手动创建或导入商品资料。'
  if (!plugin.enabled || plugin.state !== 'running')
    return 'AI 生图插件尚未运行；仍可使用手动商品工作流。'
  if (
    !plugin.capabilities.includes(AI_IMAGE_CAPABILITY) ||
    !plugin.granted.includes(AI_IMAGE_CAPABILITY)
  )
    return 'AI 生图插件缺少 image.provider 授权，请在插件中心检查。'
  if (!plugin.storageDurable)
    return 'AI 生图插件未启用持久存储，暂不能复制历史图片；可继续手动创建商品。'
  if (
    !['image.records.list', 'image.records.get', 'image.file.chunk'].every((method) =>
      plugin.methods.includes(method),
    )
  )
    return '请更新 AI 生图插件后导入生成记录。'
  return null
}
