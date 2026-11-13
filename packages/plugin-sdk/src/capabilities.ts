import type { WindowDetachInput, WindowDetachResult } from './lifecycle.js'

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

/**
 * Listing monitor: periodic collection of a marketplace's public listing
 * endpoints into a local item table, with one run record per collection. The
 * DTOs live in the plugin's own method table.
 */
export type MonitorCollector = CapabilityDescriptor

/**
 * Platform account pool: credential records plus the binding between an account
 * and a browser window. Host-private transfer methods can include credentials
 * inside an encrypted window archive; business DTOs remain owned by the plugin.
 * Every account pool advertises `window.detach` for host-owned window deletion.
 */
export interface AccountPool extends CapabilityDescriptor {
  /** Idempotently clear only the binding; keep accounts, phone and proxy data. */
  detachWindow(input: WindowDetachInput): Promise<WindowDetachResult>
}
export type WindowSync = CapabilityDescriptor
/** Mailbox accounts, read-only mail and provider-owned token refresh. */
export type EmailProvider = CapabilityDescriptor
/** Independent products, editable listing details and plugin-owned images. */
export type ProductCatalog = CapabilityDescriptor
/** Durable, host-scheduled sales workflows with scoped browser tools. */
export type SalesAgent = CapabilityDescriptor

export interface PluginCapabilityContracts {
  'proxy.provider': ProxyProvider
  'address.generator': AddressGenerator
  'supply.catalog': SupplyCatalog
  'platform.adapter': PlatformAdapter
  'verification.provider': VerificationProvider
  'image.provider': ImageProvider
  'environment.configurator': EnvironmentConfigurator
  'monitor.collector': MonitorCollector
  'account.pool': AccountPool
  'window.sync': WindowSync
  'email.provider': EmailProvider
  'product.catalog': ProductCatalog
  'sales.agent': SalesAgent
}
