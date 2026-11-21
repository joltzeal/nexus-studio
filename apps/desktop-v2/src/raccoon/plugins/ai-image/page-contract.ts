import { AI_IMAGE_CAPABILITY } from './types'

export const AI_METHODS = {
  base: [
    'image.providers.list',
    'image.providers.save',
    'image.providers.remove',
    'image.providers.test',
    'image.presets',
    'image.records.list',
    'image.records.get',
    'image.records.remove',
    'image.records.retry',
    'image.records.recognize',
    'image.generate',
    'image.upload.begin',
    'image.upload.chunk',
    'image.upload.finish',
    'image.upload.abort',
    'image.file.chunk',
  ],
  plans: ['image.plans.create', 'image.plans.get'],
  testImage: ['image.providers.testImage'],
  remote: ['image.upload.remote'],
  export: ['image.records.export'],
} as const

export type AiFeature = Exclude<keyof typeof AI_METHODS, 'base'>
export interface AiPagePlugin {
  enabled: boolean
  state: string
  capabilities: readonly string[]
  granted: readonly string[]
  methods: readonly string[]
}

export function supportsAiPage(plugin: AiPagePlugin | undefined): boolean {
  return (
    !!plugin &&
    plugin.enabled &&
    plugin.state === 'running' &&
    plugin.capabilities.includes(AI_IMAGE_CAPABILITY) &&
    plugin.granted.includes(AI_IMAGE_CAPABILITY) &&
    AI_METHODS.base.every((method) => plugin.methods.includes(method))
  )
}

export function supportsAiFeature(
  plugin: AiPagePlugin | undefined,
  feature: AiFeature,
): boolean {
  return (
    supportsAiPage(plugin) &&
    AI_METHODS[feature].every((method) => plugin!.methods.includes(method))
  )
}
