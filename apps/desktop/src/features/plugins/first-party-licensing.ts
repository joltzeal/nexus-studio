export const FIRST_PARTY_PLUGIN_IDS = [
  'studio.address-generator',
  'studio.ai-image',
  'studio.email',
  'studio.products',
  'studio.proxy-pool',
  'studio.sales-agent',
  'studio.shared-supply',
  'studio.sim8',
  'studio.vinted-accounts',
  'studio.vinted-monitor',
  'studio.window-sync',
] as const

const firstPartyPluginIds = new Set<string>(FIRST_PARTY_PLUGIN_IDS)

export function requiresPluginLicense(pluginId: string): boolean {
  return firstPartyPluginIds.has(pluginId)
}

export function hasUsablePluginLicense(state: string | undefined): boolean {
  return state === 'active'
}
