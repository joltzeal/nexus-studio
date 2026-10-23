import { describe, expect, it } from 'vitest'
import { createWindowConfig, parseWindowConfig } from './model'

describe('new native window defaults', () => {
  it('keeps GeoIP as a preference that can be saved before a proxy is assigned', () => {
    const config = createWindowConfig(42)
    expect(config.geoip).toBe(true)
    expect(config.proxy).toEqual({ protocol: 'direct', server: '' })
    expect(config.fingerprintSeed).toBe(42)
    expect(parseWindowConfig(config)).toEqual(config)
  })

  it('does not overwrite an explicitly disabled preference', () => {
    expect(parseWindowConfig({ ...createWindowConfig(42), geoip: false }).geoip).toBe(
      false,
    )
  })

  it('does not share mutable proxy settings between new windows', () => {
    const first = createWindowConfig(42)
    first.proxy.server = 'changed'
    expect(createWindowConfig(43).proxy.server).toBe('')
  })
})
