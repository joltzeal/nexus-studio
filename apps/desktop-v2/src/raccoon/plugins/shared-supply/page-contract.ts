import { SHARED_SUPPLY_CAPABILITY, SHARED_SUPPLY_PLUGIN_ID } from './model'

export const sharedSupplyFeatures = {
  base: [
    'supply.catalog',
    'supply.stores',
    'supply.products',
    'supply.search',
    'supply.imageSearch',
  ],
  images: ['supply.image.open', 'supply.image.read', 'supply.image.close'],
  favorites: [
    'supply.favorites.list',
    'supply.favorites.add',
    'supply.favorites.remove',
    'supply.favorites.csv',
  ],
} as const

type PluginAccess = {
  id: string
  enabled: boolean
  state: string
  capabilities: readonly string[]
  granted: readonly string[]
  methods: readonly string[]
}

export type SharedSupplyFeature = keyof typeof sharedSupplyFeatures

export function supportsSharedSupplyFeature(
  plugin: PluginAccess | undefined,
  feature: SharedSupplyFeature,
): boolean {
  return Boolean(
    plugin?.id === SHARED_SUPPLY_PLUGIN_ID &&
    plugin.enabled &&
    plugin.state === 'running' &&
    plugin.capabilities.includes(SHARED_SUPPLY_CAPABILITY) &&
    plugin.granted.includes(SHARED_SUPPLY_CAPABILITY) &&
    sharedSupplyFeatures[feature].every((method) => plugin.methods.includes(method)),
  )
}
