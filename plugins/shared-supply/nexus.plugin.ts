import { definePluginManifest } from '@nexus/plugin-sdk'

// Single source of truth for plugin identity. The id is immutable once published;
// renaming requires a new id plus an explicit migration.
export default definePluginManifest({
  apiVersion: 1,
  id: 'studio.shared-supply',
  version: '1.0.1',
  name: '共享货源',
  minCoreVersion: '0.1.0',
  capabilities: ['supply.catalog'],
  permissions: {
    // The supplier's own public catalogue endpoints, plus its image-search host.
    networkDomains: [
      'gz.aliyizhan.com',
      'aliyizhan.com',
      'product.aliyizhan.com',
      'thirdwx.qlogo.cn',
    ],
    wantsBrowserAccess: false,
    storage: 'private',
    // No secret slots: the catalogue needs no credential of any kind.
    secrets: [],
  },
})
