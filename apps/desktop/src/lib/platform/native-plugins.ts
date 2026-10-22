import { invoke, isTauri } from '@tauri-apps/api/core'

export interface PluginPermissions {
  networkDomains: string[]
  wantsBrowserAccess: boolean
  storage: 'private' | 'none'
  secrets: string[]
}

export type PluginState = 'available' | 'stopped' | 'running' | 'failed'

export interface PluginView {
  id: string
  name: string
  version: string
  apiVersion: number
  minCoreVersion: string
  capabilities: string[]
  granted: string[]
  permissions: PluginPermissions
  source: string
  state: PluginState
  enabled: boolean
  methods: string[]
  status: Record<string, unknown> | null
  lastError: string | null
  storageDurable: boolean
  /** Declared slot names only; the plugin owns the values. */
  secretSlots: string[]
  /** Only present for a discovered package that is not installed yet. */
  sourceDirectory: string | null
}

/** The host only exists inside the desktop shell; the web preview has none. */
export function pluginHostAvailable(): boolean {
  return isTauri()
}

export function listPlugins(): Promise<PluginView[]> {
  return invoke<PluginView[]>('plugin_catalog')
}

export function listProxyProviders(): Promise<PluginView[]> {
  return invoke<PluginView[]>('plugin_proxy_providers')
}

export function installPlugin(source: string): Promise<PluginView> {
  return invoke<PluginView>('plugin_install', { source })
}

export function uninstallPlugin(id: string): Promise<void> {
  return invoke('plugin_uninstall', { id })
}

export function enablePlugin(id: string, capabilities: string[]): Promise<PluginView> {
  return invoke<PluginView>('plugin_enable', { input: { id, capabilities } })
}

export function disablePlugin(id: string): Promise<PluginView> {
  return invoke<PluginView>('plugin_disable', { id })
}

export function restartPlugin(id: string): Promise<PluginView> {
  return invoke<PluginView>('plugin_restart', { id })
}

export function callPlugin<T>(
  id: string,
  capability: string,
  method: string,
  payload: unknown = {},
  deadlineMs?: number,
): Promise<T> {
  return invoke<T>('plugin_call', {
    input: { id, capability, method, payload, deadlineMs: deadlineMs ?? null },
  })
}
