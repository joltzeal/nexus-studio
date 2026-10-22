export interface CapabilityDescriptor {
  readonly id: string
  readonly name: string
}

// Opaque references only: no proxy credentials or raw connection configuration.
export interface ProxyResolution {
  readonly configHandle: string
  readonly secretRef?: string
}

export interface ProxyProvider extends CapabilityDescriptor {
  resolve(): Promise<ProxyResolution | null>
}

/**
 * Address generation: public address lookups plus synthetic identities. The
 * contract stays opaque here because the DTOs belong to the capability's own
 * method table, not to the host.
 */
export type AddressGenerator = CapabilityDescriptor

/**
 * Shared supply catalogue: merchant and product browsing over a supplier's own
 * public endpoints, plus a local favourites list. Like the address capability,
 * the DTOs belong to the plugin's method table.
 */
export type SupplyCatalog = CapabilityDescriptor

export type PlatformAdapter = CapabilityDescriptor
export type VerificationProvider = CapabilityDescriptor
export type ImageProvider = CapabilityDescriptor
export type EnvironmentConfigurator = CapabilityDescriptor

export interface PluginCapabilityContracts {
  'proxy.provider': ProxyProvider
  'address.generator': AddressGenerator
  'supply.catalog': SupplyCatalog
  'platform.adapter': PlatformAdapter
  'verification.provider': VerificationProvider
  'image.provider': ImageProvider
  'environment.configurator': EnvironmentConfigurator
}
