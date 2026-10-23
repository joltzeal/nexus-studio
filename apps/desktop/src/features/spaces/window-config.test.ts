import { describe, expect, it } from 'vitest'
import { parseWindowConfig } from '@/demo/model'
import type { NativeProfile } from '@/lib/platform/native-profiles'
import { configOf } from './window-config'

const CONFIG_KEYS = [
  'proxy',
  'geoip',
  'timezone',
  'locale',
  'viewport',
  'fingerprintSeed',
  'startUrl',
]

function profile(overrides: Partial<NativeProfile> = {}): NativeProfile {
  return {
    id: 'p1',
    name: 'Window',
    version: '155.0.1.2',
    proxy: null,
    proxyPlugin: null,
    proxyEndpoint: null,
    running: false,
    groupId: null,
    settings: {
      platform: 'Vinted',
      note: 'a note',
      geoip: false,
      timezone: 'Asia/Shanghai',
      locale: 'zh-CN',
      viewport: '1440x900',
      fingerprintSeed: 42,
      startUrl: 'https://example.com',
    },
    createdAt: 0,
    lastOpenedAt: null,
    ...overrides,
  }
}

describe('window editor config', () => {
  it('starts a new window from the defaults', () => {
    const config = configOf(null)
    expect(Object.keys(config)).toEqual(CONFIG_KEYS)
    expect(parseWindowConfig(config)).toEqual(config)
  })

  it('does not carry platform and note from a stored profile', () => {
    const config = configOf(profile())
    // The editor used to spread the whole settings object, which added these
    // two keys and made the strict field check reject an existing window.
    expect(Object.keys(config)).toEqual(CONFIG_KEYS)
    expect(parseWindowConfig(config)).toEqual(config)
    expect(config.timezone).toBe('Asia/Shanghai')
    expect(config.viewport).toBe('1440x900')
    expect(config.fingerprintSeed).toBe(42)
  })

  it('reads a literal proxy back into its protocol', () => {
    expect(configOf(profile({ proxy: 'socks5://host:1080' })).proxy).toEqual({
      protocol: 'socks5',
      server: 'socks5://host:1080',
    })
    expect(configOf(profile({ proxy: 'http://host:8080' })).proxy).toEqual({
      protocol: 'http',
      server: 'http://host:8080',
    })
  })

  it('keeps a plugin-resolved proxy on direct so the source select owns it', () => {
    const config = configOf(
      profile({ proxyPlugin: 'studio.proxy-pool', proxyEndpoint: 3 }),
    )
    expect(config.proxy).toEqual({ protocol: 'direct', server: '' })
    expect(parseWindowConfig(config)).toEqual(config)
  })

  it('returns a fresh default proxy each time', () => {
    const first = configOf(null)
    const second = configOf(null)
    expect(first.proxy).not.toBe(second.proxy)
  })
})
