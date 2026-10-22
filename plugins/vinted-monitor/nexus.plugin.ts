import { definePluginManifest } from '@nexus/plugin-sdk'

import { VINTED_DOMAINS } from './src/domain/urls.js'

/**
 * Every storefront plus its `api.` sibling: catalogue searches are served from
 * `api.<domain>`, wardrobes from `<domain>` itself.
 */
const networkDomains = VINTED_DOMAINS.flatMap((domain) => [domain, `api.${domain}`])

// Single source of truth for plugin identity. The id is immutable once published;
// renaming requires a new id plus an explicit migration.
export default definePluginManifest({
  apiVersion: 1,
  id: 'studio.vinted-monitor',
  version: '1.0.0',
  name: 'Vinted 商品监控',
  minCoreVersion: '0.1.0',
  capabilities: ['monitor.collector'],
  permissions: {
    networkDomains,
    wantsBrowserAccess: false,
    storage: 'private',
    // Vinted's listing endpoints are public: no credential slot is needed.
    secrets: [],
  },
})
