import type { PluginView } from '@/lib/platform/native-plugins'

export function emailProcessIdentity(
  plugin: PluginView | null,
  hostAvailable: boolean,
): string | null {
  if (
    !hostAvailable ||
    !plugin ||
    plugin.id !== 'studio.email' ||
    !plugin.enabled ||
    plugin.state !== 'running'
  )
    return null
  return JSON.stringify([
    plugin.id,
    plugin.version,
    plugin.source,
    plugin.status?.pid ?? null,
    plugin.status?.startedAt ?? null,
  ])
}
