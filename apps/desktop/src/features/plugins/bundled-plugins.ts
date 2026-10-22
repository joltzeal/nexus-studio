import addressManifest from '@nexus/plugin-address-generator/manifest'
import aiImageManifest from '@nexus/plugin-ai-image/manifest'
import proxyManifest from '@nexus/plugin-proxy-pool/manifest'
import supplyManifest from '@nexus/plugin-shared-supply/manifest'
import vintedAccountsManifest from '@nexus/plugin-vinted-accounts/manifest'
import vintedMonitorManifest from '@nexus/plugin-vinted-monitor/manifest'

/**
 * Plugins whose package is built from this repository, shown by the web
 * preview where there is no host. Only the manifest declaration is read: no
 * entry point, process, capability method or credential is loaded.
 */
export const BUNDLED_PLUGINS = [
  proxyManifest,
  addressManifest,
  supplyManifest,
  aiImageManifest,
  vintedMonitorManifest,
  vintedAccountsManifest,
] as const
