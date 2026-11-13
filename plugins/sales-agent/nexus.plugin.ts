import { definePluginManifest } from '@nexus/plugin-sdk'

export default definePluginManifest({
  apiVersion: 1,
  id: 'studio.sales-agent',
  version: '1.0.0',
  name: 'ecom agent',
  minCoreVersion: '0.1.29',
  capabilities: ['sales.agent'],
  permissions: {
    networkDomains: [],
    wantsBrowserAccess: true,
    storage: 'private',
    secrets: ['decision-api-key', 'generation-api-key'],
  },
})
