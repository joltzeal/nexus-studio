export {
  NetworkDomainSchema,
  PluginCapabilitySchema,
  PluginManifestSchema,
  PluginPermissionsSchema,
  definePluginManifest,
} from './manifest.js'
export type { PluginCapability, PluginManifest, PluginPermissions } from './manifest.js'
export type {
  AddressGenerator,
  CapabilityDescriptor,
  EnvironmentConfigurator,
  ImageProvider,
  PlatformAdapter,
  PluginCapabilityContracts,
  ProxyProvider,
  ProxyResolution,
  SupplyCatalog,
  VerificationProvider,
} from './capabilities.js'
