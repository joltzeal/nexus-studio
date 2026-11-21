import { VINTED_CAPABILITY, VINTED_PLUGIN_ID } from './model.ts'

export { VINTED_CAPABILITY, VINTED_PLUGIN_ID }

export const VINTED_METHODS = {
  base: [
    'vinted.monitors.list',
    'vinted.monitors.save',
    'vinted.monitors.remove',
    'vinted.monitors.run',
    'vinted.runs.list',
    'vinted.runs.get',
    'vinted.items.list',
    'vinted.items.get',
    'vinted.items.star',
    'vinted.items.availability',
    'vinted.items.remove',
    'vinted.items.monitorSeller',
    'vinted.proxies.list',
    'vinted.proxies.save',
    'vinted.proxies.remove',
    'vinted.proxies.default',
    'vinted.url.inspect',
  ],
  images: ['vinted.image.open', 'vinted.image.read', 'vinted.image.close'],
} as const

type PluginShape = {
  id?: string
  capabilities: readonly string[]
  granted: readonly string[]
  methods: readonly string[]
  enabled: boolean
  state: string
}

export function supportsVintedMonitor(plugin: PluginShape | undefined): boolean {
  return (
    !!plugin &&
    plugin.id === VINTED_PLUGIN_ID &&
    plugin.enabled &&
    plugin.state === 'running' &&
    plugin.capabilities.includes(VINTED_CAPABILITY) &&
    plugin.granted.includes(VINTED_CAPABILITY) &&
    VINTED_METHODS.base.every((method) => plugin.methods.includes(method))
  )
}

export function supportsVintedImages(plugin: PluginShape | undefined): boolean {
  if (!supportsVintedMonitor(plugin) || !plugin) return false
  return VINTED_METHODS.images.every((method) => plugin.methods.includes(method))
}
