import { invoke, isTauri } from '@tauri-apps/api/core'

export interface PluginPermissions {
  networkDomains: string[]
  wantsBrowserAccess: boolean
  storage: 'private' | 'none'
  secrets: string[]
}

/**
 * `available` is a discovered package that is not installed yet. Everything
 * else is owned by the host: it starts installed plugins on boot and restarts
 * them when they die, so there is no stopped or failed state to act on.
 */
export type PluginState = 'available' | 'starting' | 'running' | 'retrying'

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
  /**
   * The directory this plugin can be installed from: a package that is not
   * installed yet, or the development copy an installed one is refreshed from.
   */
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

/** `install` means the store has a plugin this machine does not run yet. */
export type MarketEntryState = 'install' | 'update' | 'current'

export interface MarketEntry {
  id: string
  name: string
  version: string
  apiVersion: number
  minCoreVersion: string
  description: string
  changelog: string
  capabilities: string[]
  installedVersion: string | null
  state: MarketEntryState
  size: number
  checksum: string
}

export interface MarketStatus {
  storeUrl: string | null
  catalogUrl: string | null
  /** Unix seconds, or null when the store was never reached. */
  lastCheckedAt: string | null
  lastError: string | null
  entries: MarketEntry[]
}

export function marketStatus(): Promise<MarketStatus> {
  return invoke<MarketStatus>('plugin_market_status')
}

export function setMarketStore(url: string | null): Promise<MarketStatus> {
  return invoke<MarketStatus>('plugin_market_set_store', { url })
}

export function refreshMarket(): Promise<MarketStatus> {
  return invoke<MarketStatus>('plugin_market_refresh')
}

export function installFromMarket(id: string): Promise<PluginView> {
  return invoke<PluginView>('plugin_market_install', { id })
}
