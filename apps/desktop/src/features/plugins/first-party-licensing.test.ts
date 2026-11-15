import { describe, expect, it } from 'vitest'
import {
  FIRST_PARTY_PLUGIN_IDS,
  hasUsablePluginLicense,
  requiresPluginLicense,
} from './first-party-licensing'

describe('first-party plugin licensing', () => {
  it('covers the eleven first-party market plugins', () => {
    expect(FIRST_PARTY_PLUGIN_IDS).toHaveLength(11)
    for (const id of FIRST_PARTY_PLUGIN_IDS) expect(requiresPluginLicense(id)).toBe(true)
  })

  it('does not infer paid status from a plugin id prefix', () => {
    expect(requiresPluginLicense('studio.third-party')).toBe(false)
    expect(requiresPluginLicense('vendor.plugin')).toBe(false)
  })

  it('allows actions only with a currently valid lease', () => {
    expect(hasUsablePluginLicense('active')).toBe(true)
    expect(hasUsablePluginLicense('needsConnection')).toBe(false)
    expect(hasUsablePluginLicense('expired')).toBe(false)
    expect(hasUsablePluginLicense(undefined)).toBe(false)
  })
})
