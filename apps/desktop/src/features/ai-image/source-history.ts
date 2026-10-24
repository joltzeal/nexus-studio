import type { PluginView } from '@/lib/platform/native-plugins'
import { AI_IMAGE_PLUGIN_ID } from './types'

export function sourceHistoryAvailability(
  hostAvailable: boolean,
  plugins: PluginView[],
): 'desktop' | 'missing' | 'disabled' | 'starting' | 'ready' {
  if (!hostAvailable) return 'desktop'
  const plugin = plugins.find((entry) => entry.id === AI_IMAGE_PLUGIN_ID)
  if (plugin === undefined || plugin.state === 'available') return 'missing'
  if (!plugin.enabled) return 'disabled'
  return plugin.state === 'running' ? 'ready' : 'starting'
}
