import { definePluginManifest } from '@nexus/plugin-sdk'

// Single source of truth for plugin identity. The id is immutable once published;
// renaming requires a new id plus an explicit migration.
export default definePluginManifest({
  apiVersion: 1,
  id: 'studio.ai-image',
  version: '1.0.1',
  name: 'AI 生图',
  minCoreVersion: '0.1.0',
  capabilities: ['image.provider'],
  permissions: {
    // The provider base URL is user supplied, so the declared list covers the
    // official endpoint plus the common compatible gateways. It is a request
    // list, not an allow-list the host enforces today.
    networkDomains: [
      'api.openai.com',
      'api.deepseek.com',
      'openrouter.ai',
      'api.siliconflow.cn',
      'api.moonshot.cn',
      'dashscope.aliyuncs.com',
    ],
    wantsBrowserAccess: false,
    storage: 'private',
    // No secret slots: the page writes the API key into the plugin's own private
    // document, because a user-configured provider is not a host-managed secret.
    secrets: [],
  },
})
