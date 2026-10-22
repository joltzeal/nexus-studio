import { describe, expect, it } from 'vitest'
import { PluginManifestSchema } from '@nexus/plugin-sdk'

import manifest from '../nexus.plugin.js'

describe('proxy pool manifest', () => {
  it('declares exactly the capability and domains the plugin uses', () => {
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true)
    expect(manifest.capabilities).toEqual(['proxy.provider'])
    expect(manifest.permissions.networkDomains.sort()).toEqual([
      'api64.ipify.org',
      'proxycheck.io',
    ])
    expect(manifest.permissions.wantsBrowserAccess).toBe(false)
    expect(manifest.permissions.storage).toBe('private')
    expect(manifest.permissions.secrets).toEqual([
      'proxy-password',
      'proxycheck-api-key',
      'subscription-token',
    ])
  })

  it.each([
    { apiVersion: 2 },
    { id: 'proxy-pool' },
    { version: '1.0' },
    { capabilities: ['browser.launch'] },
    { permissions: { ...manifest.permissions, networkDomains: ['*.ipify.org'] } },
    {
      permissions: { ...manifest.permissions, networkDomains: ['https://proxycheck.io'] },
    },
    { permissions: { ...manifest.permissions, storage: 'shared' } },
    { permissions: { ...manifest.permissions, secrets: [''] } },
    { permissions: { ...manifest.permissions, wantsBrowserAccess: 'yes' } },
    { entry: './dist/index.js' },
  ])('rejects a manifest that would grant more than declared: %j', (override) => {
    expect(PluginManifestSchema.safeParse({ ...manifest, ...override }).success).toBe(
      false,
    )
  })
})
