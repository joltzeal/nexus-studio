import { ADDRESS_PLUGIN_ID, ADDRESS_CAPABILITY } from './model.ts'

export const ADDRESS_METHODS = {
  base: ['address.catalog', 'address.profile'],
  saved: ['address.saved.list', 'address.saved.save', 'address.saved.remove'],
  csv: ['address.csv'],
  export: ['address.export'],
} as const
type Access = {
  id: string
  enabled: boolean
  state: string
  capabilities: readonly string[]
  granted: readonly string[]
  methods: readonly string[]
}
export function supportsAddressPage(plugin: Access | undefined): boolean {
  return (
    !!plugin &&
    plugin.id === ADDRESS_PLUGIN_ID &&
    plugin.enabled &&
    plugin.state === 'running' &&
    plugin.capabilities.includes(ADDRESS_CAPABILITY) &&
    plugin.granted.includes(ADDRESS_CAPABILITY) &&
    ADDRESS_METHODS.base.every((method) => plugin.methods.includes(method))
  )
}
export function supportsAddressFeature(
  plugin: Access | undefined,
  feature: Exclude<keyof typeof ADDRESS_METHODS, 'base'>,
): boolean {
  return (
    supportsAddressPage(plugin) &&
    ADDRESS_METHODS[feature].every((method) => plugin!.methods.includes(method))
  )
}
