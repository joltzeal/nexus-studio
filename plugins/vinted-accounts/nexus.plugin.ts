import { definePluginManifest } from '@nexus/plugin-sdk'
import { VINTED_DOMAINS } from './src/services/order-source.js'

// Single source of truth for plugin identity. The id is immutable once published;
// renaming requires a new id plus an explicit migration.
export default definePluginManifest({
  apiVersion: 1,
  id: 'studio.vinted-accounts',
  version: '1.1.0',
  name: 'Vinted 账号池',
  minCoreVersion: '0.1.21',
  capabilities: ['account.pool'],
  permissions: {
    // Custom Bark services and saved OTP links are user supplied. As with other
    // Node plugins, this declaration is not an enforced fetch allow-list.
    networkDomains: [
      ...VINTED_DOMAINS.flatMap((domain) => [domain, `www.${domain}`]),
      'api.day.app',
    ],
    wantsBrowserAccess: false,
    storage: 'private',
    secrets: [],
  },
})
