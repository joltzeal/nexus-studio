import { definePluginManifest } from '@nexus/plugin-sdk'

// Single source of truth for plugin identity. The id is immutable once published;
// renaming requires a new id plus an explicit migration.
export default definePluginManifest({
  apiVersion: 1,
  id: 'studio.address-generator',
  version: '1.0.0',
  name: '地址生成器',
  minCoreVersion: '0.1.0',
  capabilities: ['address.generator'],
  permissions: {
    // Public address lookups only. The plugin never talks to a marketplace.
    networkDomains: ['overpass-api.de', 'maps.mail.ru'],
    wantsBrowserAccess: false,
    storage: 'private',
    // A Google Maps browser key, stored on behalf of the page that loads the SDK.
    // It is a referrer-restricted browser key, not a server credential.
    secrets: ['google-maps-key'],
  },
})
