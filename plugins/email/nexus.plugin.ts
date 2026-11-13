import { definePluginManifest } from '@nexus/plugin-sdk'

export default definePluginManifest({
  apiVersion: 1,
  id: 'studio.email',
  version: '1.1.1',
  name: '邮箱管理',
  minCoreVersion: '0.1.28',
  capabilities: ['email.provider'],
  permissions: {
    networkDomains: [
      'login.microsoftonline.com',
      'graph.microsoft.com',
      'outlook.office365.com',
    ],
    wantsBrowserAccess: false,
    storage: 'private',
    secrets: [],
  },
})
