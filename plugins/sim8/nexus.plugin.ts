import { definePluginManifest } from '@nexus/plugin-sdk'

// Single source of truth for plugin identity. The id is immutable once published;
// renaming requires a new id plus an explicit migration.
export default definePluginManifest({
  apiVersion: 1,
  id: 'studio.sim8',
  version: '1.0.1',
  name: 'SIM8 接码',
  minCoreVersion: '0.1.0',
  // Numbers and their verification codes are a verification source, so the host
  // sees this plugin next to any other provider of the same capability.
  capabilities: ['verification.provider'],
  permissions: {
    // `https://api.cc` is the documented service host. The base URL is a user
    // setting because the provider hands out per-account domains, so this list
    // can only declare the default; it is a request, not an enforced allowlist.
    networkDomains: ['api.cc'],
    wantsBrowserAccess: false,
    storage: 'private',
    // The account's API token. It is pasted by the user, stored in the plugin's
    // own 0600 vault and never written into the plugin document.
    secrets: ['api-token'],
  },
})
