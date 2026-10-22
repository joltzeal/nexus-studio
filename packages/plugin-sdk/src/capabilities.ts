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

export type PlatformAdapter = CapabilityDescriptor
export type VerificationProvider = CapabilityDescriptor
export type ImageProvider = CapabilityDescriptor
export type EnvironmentConfigurator = CapabilityDescriptor

export interface PluginCapabilityContracts {
  'proxy.provider': ProxyProvider
  'address.generator': AddressGenerator
  'platform.adapter': PlatformAdapter
  'verification.provider': VerificationProvider
  'image.provider': ImageProvider
  'environment.configurator': EnvironmentConfigurator
}
