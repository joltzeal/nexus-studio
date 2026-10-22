import { z } from 'zod'

const pluginIdPattern =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const domainPattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/i

export const PluginCapabilitySchema = z.enum([
  'proxy.provider',
  'address.generator',
  'platform.adapter',
  'verification.provider',
  'image.provider',
  'environment.configurator',
])

export const NetworkDomainSchema = z.string().max(253).regex(domainPattern)

// These are permission requests. A future host must enforce its own permission policy.
export const PluginPermissionsSchema = z.strictObject({
  networkDomains: z.array(NetworkDomainSchema),
  wantsBrowserAccess: z.boolean(),
  storage: z.enum(['private', 'none']),
  secrets: z.array(z.string().trim().min(1).max(128)),
})

export const PluginManifestSchema = z.strictObject({
  apiVersion: z.literal(1),
  id: z.string().max(253).regex(pluginIdPattern),
  version: z.string().regex(semverPattern),
  name: z.string().trim().min(1).max(80),
  minCoreVersion: z.string().regex(semverPattern),
  capabilities: z.array(PluginCapabilitySchema),
  permissions: PluginPermissionsSchema,
})

export type PluginCapability = z.infer<typeof PluginCapabilitySchema>
export type PluginPermissions = z.infer<typeof PluginPermissionsSchema>
export type PluginManifest = z.infer<typeof PluginManifestSchema>

export function definePluginManifest(input: unknown): PluginManifest {
  return PluginManifestSchema.parse(input)
}
