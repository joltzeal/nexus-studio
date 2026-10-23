import { describe, expect, it } from 'vitest'
import { PluginManifestSchema } from '@nexus/plugin-sdk'

import manifest from '../nexus.plugin.js'
import { SIM8_METHODS } from './capabilities/sim8.js'

describe('sim8 manifest', () => {
  it('declares exactly the capability, domain and slot it uses', () => {
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true)
    expect(manifest.id).toBe('studio.sim8')
    expect(manifest.capabilities).toEqual(['verification.provider'])
    expect(manifest.permissions.networkDomains).toEqual(['api.cc'])
    expect(manifest.permissions.wantsBrowserAccess).toBe(false)
    expect(manifest.permissions.storage).toBe('private')
    // The token is the only secret: numbers live in the plugin document.
    expect(manifest.permissions.secrets).toEqual(['api-token'])
  })

  it.each([
    { apiVersion: 2 },
    { id: 'sim8' },
    { capabilities: ['browser.launch'] },
    { permissions: { ...manifest.permissions, networkDomains: ['*.api.cc'] } },
    { permissions: { ...manifest.permissions, storage: 'shared' } },
    { permissions: { ...manifest.permissions, secrets: [''] } },
    { entry: './dist/index.js' },
  ])('rejects a manifest that would grant more than declared: %j', (override) => {
    expect(PluginManifestSchema.safeParse({ ...manifest, ...override }).success).toBe(
      false,
    )
  })

  it('lists every method exactly once', () => {
    expect(SIM8_METHODS.length).toBe(21)
    expect(new Set(SIM8_METHODS).size).toBe(SIM8_METHODS.length)
    for (const method of SIM8_METHODS) expect(method.startsWith('sim8.')).toBe(true)
  })
})
