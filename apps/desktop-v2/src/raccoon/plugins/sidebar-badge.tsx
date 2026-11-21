import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { PluginView } from './types'
import { ACCOUNT_PLUGIN_ID } from './vinted-accounts/model'

export type PluginSidebarBadgeComponent = ComponentType<{ plugin: PluginView }>

const badges = new Map<string, PluginSidebarBadgeComponent>()
const listeners = new Set<() => void>()
let snapshot: ReadonlyMap<string, PluginSidebarBadgeComponent> = badges

function changed() {
  snapshot = new Map(badges)
  for (const listener of listeners) listener()
}

/// Registers the component a plugin draws at the end of its sidebar row:
/// a count, a state or another compact value. The returned function removes
/// it. Until a plugin registers one, its row keeps the normal empty slot.
export function registerPluginSidebarBadge(
  pluginId: string,
  Badge: PluginSidebarBadgeComponent,
) {
  badges.set(pluginId, Badge)
  changed()
  return () => {
    if (badges.get(pluginId) !== Badge) return
    badges.delete(pluginId)
    changed()
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const current = () => snapshot

/// The reserved badge slot for a plugin row.
export function usePluginSidebarBadge(plugin: PluginView): ReactNode {
  const registered = useSyncExternalStore(subscribe, current)
  const Badge = registered.get(plugin.id)
  return Badge ? <Badge plugin={plugin} /> : null
}

/// The account-pool count is not in the plugin protocol yet. This component
/// is the reserved place for it and already accepts a `sidebarBadge` (or
/// `accountCount`) value from the plugin's status until a real component
/// replaces it.
function VintedAccountsSidebarBadge({ plugin }: { plugin: PluginView }) {
  const status = plugin.status
  const row =
    status && typeof status === 'object' && !Array.isArray(status)
      ? (status as Record<string, unknown>)
      : null
  const value = row?.sidebarBadge ?? row?.accountCount
  return (
    <span data-plugin-sidebar-badge={plugin.id}>
      {typeof value === 'number' || typeof value === 'string' ? value : ''}
    </span>
  )
}

registerPluginSidebarBadge(ACCOUNT_PLUGIN_ID, VintedAccountsSidebarBadge)
