import { describe, expect, it } from 'vitest'
import { sharedSupplyFeatures, supportsSharedSupplyFeature } from './page-contract'

const plugin = {
  id: 'studio.shared-supply',
  enabled: true,
  state: 'running',
  capabilities: ['supply.catalog'],
  granted: ['supply.catalog'],
  methods: [
    ...sharedSupplyFeatures.base,
    ...sharedSupplyFeatures.images,
    ...sharedSupplyFeatures.favorites,
  ],
}

describe('shared supply capability gates', () => {
  it('requires the complete catalog/search base method set', () => {
    expect(supportsSharedSupplyFeature(plugin, 'base')).toBe(true)
    expect(
      supportsSharedSupplyFeature(
        {
          ...plugin,
          methods: plugin.methods.filter((method) => method !== 'supply.imageSearch'),
        },
        'base',
      ),
    ).toBe(false)
  })

  it('keeps image and favorite features independently gated', () => {
    expect(
      supportsSharedSupplyFeature(
        {
          ...plugin,
          methods: plugin.methods.filter((method) => !method.startsWith('supply.image.')),
        },
        'base',
      ),
    ).toBe(true)
    expect(
      supportsSharedSupplyFeature(
        {
          ...plugin,
          methods: plugin.methods.filter((method) => !method.startsWith('supply.image.')),
        },
        'images',
      ),
    ).toBe(false)
    expect(
      supportsSharedSupplyFeature(
        {
          ...plugin,
          methods: plugin.methods.filter((method) => method !== 'supply.favorites.csv'),
        },
        'favorites',
      ),
    ).toBe(false)
  })
})
