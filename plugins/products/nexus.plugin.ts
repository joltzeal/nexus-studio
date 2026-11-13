import { definePluginManifest } from '@nexus/plugin-sdk'

export default definePluginManifest({
  apiVersion: 1,
  id: 'studio.products',
  version: '1.0.1',
  name: '商品管理',
  minCoreVersion: '0.1.29',
  capabilities: ['product.catalog'],
  permissions: {
    networkDomains: [],
    wantsBrowserAccess: false,
    storage: 'private',
    secrets: [],
  },
})
