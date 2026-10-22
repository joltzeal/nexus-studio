import { describe, expect, it } from 'vitest'
import { PluginManifestSchema } from '@nexus/plugin-sdk'

import manifest from '../nexus.plugin.js'
import { SUPPLY_METHODS } from './capabilities/shared-supply.js'

describe('shared supply manifest', () => {
  it('declares exactly the capability, domains and slots it uses', () => {
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true)
    expect(manifest.id).toBe('studio.shared-supply')
    expect(manifest.capabilities).toEqual(['supply.catalog'])
    expect(manifest.permissions.networkDomains).toEqual([
      'gz.aliyizhan.com',
      'aliyizhan.com',
      'product.aliyizhan.com',
    ])
    expect(manifest.permissions.wantsBrowserAccess).toBe(false)
    expect(manifest.permissions.storage).toBe('private')
    // The catalogue needs no credential; an empty slot list says so explicitly.
    expect(manifest.permissions.secrets).toEqual([])
  })

  it.each([
    { apiVersion: 2 },
    { id: 'shared-supply' },
    { capabilities: ['browser.launch'] },
    { permissions: { ...manifest.permissions, networkDomains: ['*.aliyizhan.com'] } },
    { permissions: { ...manifest.permissions, storage: 'shared' } },
    { permissions: { ...manifest.permissions, secrets: [''] } },
    { entry: './dist/index.js' },
  ])('rejects a manifest that would grant more than declared: %j', (override) => {
    expect(PluginManifestSchema.safeParse({ ...manifest, ...override }).success).toBe(
      false,
    )
  })

  it('names the methods it actually implements', () => {
    expect([...SUPPLY_METHODS]).toEqual([
      'supply.catalog',
      'supply.stores',
      'supply.products',
      'supply.search',
      'supply.imageSearch',
      'supply.favorites.list',
      'supply.favorites.add',
      'supply.favorites.remove',
      'supply.favorites.csv',
    ])
  })
})
