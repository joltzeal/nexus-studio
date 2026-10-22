import { definePluginManifest } from '@nexus/plugin-sdk'

// Single source of truth for plugin identity. The id is immutable once published;
// renaming requires a new id plus an explicit migration.
export default definePluginManifest({
  apiVersion: 1,
  id: 'studio.vinted-accounts',
  version: '1.0.0',
  name: 'Vinted 账号池',
  minCoreVersion: '0.1.0',
  capabilities: ['account.pool'],
  permissions: {
    // Credentials never leave the private store: the plugin makes no network
    // calls of its own, and the homepage links are opened by the host.
    networkDomains: [],
    wantsBrowserAccess: false,
    storage: 'private',
    secrets: [],
  },
})
