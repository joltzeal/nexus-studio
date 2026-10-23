import { describe, expect, it } from 'vitest'
import { browserOptionsForWindow } from './profile-runtime.js'

describe('window browser options', () => {
  it('blocks a plugin window if its resolved connection never reaches the adapter', () => {
    expect(() =>
      browserOptionsForWindow('/data/profile', {
        proxy: null,
        proxy_plugin: 'studio.proxy-pool',
      }),
    ).toThrow('PROFILE_PROXY_MISSING')
  })

  it('passes the selected connection and authentication to the browser', () => {
    const proxy = 'socks5://account:p%40ss@selected.example:1080'
    expect(
      browserOptionsForWindow('/data/profile', {
        proxy,
        proxy_plugin: 'studio.proxy-pool',
      }).proxy,
    ).toBe(proxy)
  })

  it('enables GeoIP for proxied profiles without saved settings', () => {
    expect(
      browserOptionsForWindow('/data/profile', {
        proxy: 'http://account:password@proxy.example:8080',
      }).geoip,
    ).toBe(true)
  })

  it('ignores the auto GeoIP preference on a direct connection', () => {
    expect(
      browserOptionsForWindow('/data/profile', {
        proxy: null,
        settings: {
          platform: '',
          note: '',
          geoip: true,
          timezone: '',
          locale: '',
          viewport: 'default',
          fingerprintSeed: null,
          startUrl: '',
        },
      }).geoip,
    ).not.toBe(true)
  })

  it('honors an explicitly disabled GeoIP preference with a proxy', () => {
    expect(
      browserOptionsForWindow('/data/profile', {
        proxy: 'socks5://proxy.example:1080',
        settings: {
          platform: '',
          note: '',
          geoip: false,
          timezone: '',
          locale: '',
          viewport: 'default',
          fingerprintSeed: null,
          startUrl: '',
        },
      }).geoip,
    ).not.toBe(true)
  })

  it('maps saved settings into the persistent browser launch', () => {
    expect(
      browserOptionsForWindow('/data/profile', {
        proxy: 'socks5://proxy.local:1080',
        settings: {
          platform: 'Vinted',
          note: '',
          geoip: true,
          timezone: 'America/New_York',
          locale: 'en-US',
          viewport: '1440x900',
          fingerprintSeed: 42,
          startUrl: 'https://www.vinted.com',
        },
      }),
    ).toEqual({
      userDataDir: '/data/profile',
      headless: false,
      proxy: 'socks5://proxy.local:1080',
      geoip: true,
      timezone: 'America/New_York',
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      args: ['--fingerprint=42'],
    })
  })
})
