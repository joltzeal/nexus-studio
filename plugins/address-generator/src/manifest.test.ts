import { describe, expect, it } from 'vitest'
import { PluginManifestSchema } from '@nexus/plugin-sdk'

import manifest from '../nexus.plugin.js'
import { ADDRESS_METHODS } from './capabilities/address-generator.js'

describe('address generator manifest', () => {
  it('declares exactly the capability, domains and slots it uses', () => {
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true)
    expect(manifest.id).toBe('studio.address-generator')
    expect(manifest.capabilities).toEqual(['address.generator'])
    expect(manifest.permissions.networkDomains).toEqual([
      'overpass-api.de',
      'maps.mail.ru',
    ])
    expect(manifest.permissions.wantsBrowserAccess).toBe(false)
    expect(manifest.permissions.storage).toBe('private')
    expect(manifest.permissions.secrets).toEqual(['google-maps-key'])
  })

  it.each([
    { apiVersion: 2 },
    { id: 'address-generator' },
    { capabilities: ['browser.launch'] },
    { permissions: { ...manifest.permissions, networkDomains: ['*.overpass-api.de'] } },
    { permissions: { ...manifest.permissions, storage: 'shared' } },
    { permissions: { ...manifest.permissions, secrets: [''] } },
    { entry: './dist/index.js' },
  ])('rejects a manifest that would grant more than declared: %j', (override) => {
    expect(PluginManifestSchema.safeParse({ ...manifest, ...override }).success).toBe(
      false,
    )
  })

  it('names the methods it actually implements', () => {
    expect([...ADDRESS_METHODS]).toEqual([
      'address.catalog',
      'address.generate',
      'address.profile',
      'address.csv',
      'address.export',
      'address.config.get',
      'address.config.set',
    ])
  })
})
