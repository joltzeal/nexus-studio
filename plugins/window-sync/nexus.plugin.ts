// Dependency-free so transport can be built independently of the parent SDK update.
// The host must validate the emitted JSON with the window.sync-aware SDK schema.
export default {
  apiVersion: 1,
  id: 'studio.window-sync',
  version: '1.0.0',
  name: '窗口同步',
  minCoreVersion: '0.1.3',
  capabilities: ['window.sync'],
  permissions: {
    networkDomains: [],
    wantsBrowserAccess: false,
    storage: 'private',
    secrets: [],
  },
} as const
