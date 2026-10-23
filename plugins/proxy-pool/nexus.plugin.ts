import { definePluginManifest } from '@nexus/plugin-sdk'

// Single source of truth for plugin identity. The id is immutable once published;
// renaming requires a new id plus an explicit migration.
export default definePluginManifest({
  apiVersion: 1,
  id: 'studio.proxy-pool',
  version: '1.0.2',
  name: '代理池',
  minCoreVersion: '0.1.0',
  capabilities: ['proxy.provider'],
  permissions: {
    // Exit-IP detection and IP reputation. No wildcard, no dynamic hosts.
    networkDomains: ['api64.ipify.org', 'proxycheck.io'],
    wantsBrowserAccess: false,
    storage: 'private',
    // Slot names only. Values live in the host credential store.
    secrets: ['proxy-password', 'proxycheck-api-key', 'subscription-token'],
  },
})
