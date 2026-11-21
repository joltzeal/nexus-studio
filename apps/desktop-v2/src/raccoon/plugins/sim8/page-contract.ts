import { SIM8_CAPABILITY, SIM8_METHODS, type Sim8MethodGroup } from './methods.ts'

export function supportsSim8Page(
  plugin:
    | {
        capabilities: readonly string[]
        granted: readonly string[]
        methods: readonly string[]
        enabled: boolean
        state: string
      }
    | undefined,
): boolean {
  if (!plugin || !plugin.enabled || plugin.state !== 'running') return false
  if (
    !plugin.capabilities.includes(SIM8_CAPABILITY) ||
    !plugin.granted.includes(SIM8_CAPABILITY)
  )
    return false
  return SIM8_METHODS.base.every((method) => plugin.methods.includes(method))
}

export function sim8OptionalGroup(
  plugin: { methods: readonly string[] } | undefined,
  group: Exclude<Sim8MethodGroup, 'base'>,
) {
  return (
    plugin !== undefined &&
    SIM8_METHODS[group].every((method) => plugin.methods.includes(method))
  )
}
