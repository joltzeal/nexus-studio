import { describe, expect, it } from 'vitest'
import { browserOptionsForWindow } from './profile-runtime.js'

describe('window browser options', () => {
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
