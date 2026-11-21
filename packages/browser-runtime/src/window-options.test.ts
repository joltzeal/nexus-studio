import { describe, expect, it } from 'vitest'
import { runtimeWindow } from '../fixtures/runtime-window.js'
import { browserOptionsForWindow } from './profile-runtime.js'

describe('window browser options', () => {
  it('exposes an ephemeral loopback CDP endpoint only for an interactive automation launch', () => {
    const options = browserOptionsForWindow('/data/profile', runtimeWindow(), true)
    expect(options.args).toEqual([
      '--fingerprint=123456789',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ])
    expect(browserOptionsForWindow('/data/profile', runtimeWindow()).args).toEqual([
      '--fingerprint=123456789',
    ])
  })

  it('blocks a plugin window if its resolved connection never reaches the adapter', () => {
    expect(() =>
      browserOptionsForWindow(
        '/data/profile',
        runtimeWindow({
          proxy: null,
          proxy_plugin: 'studio.proxy-pool',
          proxy_mode: 'plugin',
        }),
      ),
    ).toThrow('PROFILE_PROXY_MISSING')
  })

  it('passes the selected connection and authentication to the browser', () => {
    const proxy = 'socks5://account:p%40ss@selected.example:1080'
    expect(
      browserOptionsForWindow(
        '/data/profile',
        runtimeWindow({
          proxy,
          proxy_plugin: 'studio.proxy-pool',
          proxy_mode: 'plugin',
        }),
      ).proxy,
    ).toBe(proxy)
  })

  it('enables online IP matching for a proxy with the saved preference', () => {
    expect(
      browserOptionsForWindow(
        '/data/profile',
        runtimeWindow({
          proxy: 'http://account:password@proxy.example:8080',
          proxy_mode: 'manual',
        }),
      ).geoip,
    ).toBe(true)
  })

  it('ignores the auto GeoIP preference on a direct connection', () => {
    expect(
      browserOptionsForWindow(
        '/data/profile',
        runtimeWindow({
          proxy: null,
          settings: {
            platform: '',
            note: '',
            geoip: true,
            timezone: '',
            locale: '',
            viewport: 'default',
            fingerprintSeed: 123456789,
            aliasEngine: null,
            operatingSystem: 'host',
            cpuCores: null,
            startUrl: '',
          },
        }),
      ).geoip,
    ).not.toBe(true)
  })

  it('honors an explicitly disabled GeoIP preference with a proxy', () => {
    expect(
      browserOptionsForWindow(
        '/data/profile',
        runtimeWindow({
          proxy: 'socks5://proxy.example:1080',
          proxy_mode: 'manual',
          settings: {
            platform: '',
            note: '',
            geoip: false,
            timezone: '',
            locale: '',
            viewport: 'default',
            fingerprintSeed: 123456789,
            aliasEngine: null,
            operatingSystem: 'host',
            cpuCores: null,
            startUrl: '',
          },
        }),
      ).geoip,
    ).not.toBe(true)
  })

  it('maps saved settings into the persistent browser launch', () => {
    expect(
      browserOptionsForWindow(
        '/data/profile',
        runtimeWindow({
          proxy: 'socks5://proxy.local:1080',
          proxy_mode: 'manual',
          settings: {
            platform: 'Vinted',
            note: '',
            geoip: true,
            timezone: 'America/New_York',
            locale: 'en-US',
            viewport: '1440x900',
            fingerprintSeed: 42,
            aliasEngine: null,
            operatingSystem: 'host',
            cpuCores: null,
            startUrl: 'https://www.vinted.com',
          },
        }),
      ),
    ).toEqual({
      userDataDir: '/data/profile',
      headless: false,
      proxy: 'socks5://proxy.local:1080',
      geoip: true,
      timezone: 'America/New_York',
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      args: [
        '--fingerprint=42',
        '--fingerprint-timezone=America/New_York',
        '--fingerprint-locale=en-US',
      ],
    })
  })

  it('forwards only explicit CloakBrowser fingerprint overrides', () => {
    const options = browserOptionsForWindow(
      '/data/profile',
      runtimeWindow({
        proxy: 'socks5://proxy.local:1080',
        proxy_mode: 'manual',
        settings: {
          platform: '',
          note: '',
          geoip: false,
          timezone: '',
          locale: '',
          viewport: 'default',
          fingerprintSeed: 42069,
          aliasEngine: null,
          operatingSystem: 'host',
          cpuCores: null,
          startUrl: '',
          cloakbrowser: {
            platform: 'macos',
            gpuVendor: 'nvidia',
            hardwareConcurrency: 12,
            deviceMemory: 16,
            screenWidth: 2560,
            screenHeight: 1440,
            platformVersion: '15.0.0',
            storageQuota: 2048,
            taskbarHeight: 0,
            webrtcIp: 'auto',
            noise: false,
            allowThirdPartyCookies: true,
            sapiVoices: false,
            maxTouchPoints: 0,
            searchEngine: 'duckduckgo',
            transparentProxy: true,
            transparentProxyDns: 'local',
            portableCookies: true,
          },
        },
      }),
    )
    expect(options.args).toEqual([
      '--fingerprint=42069',
      '--fingerprint-platform=macos',
      '--fingerprint-gpu-vendor=NVIDIA',
      '--fingerprint-hardware-concurrency=12',
      '--fingerprint-device-memory=16',
      '--fingerprint-screen-width=2560',
      '--fingerprint-screen-height=1440',
      '--fingerprint-platform-version=15.0.0',
      '--fingerprint-storage-quota=2048',
      '--fingerprint-taskbar-height=0',
      '--fingerprint-webrtc-ip=auto',
      '--fingerprint-noise=false',
      '--fingerprint-allow-3p-cookies',
      '--fingerprint-sapi-voices=false',
      '--fingerprint-max-touch-points=0',
      '--fingerprint-search-engine=duckduckgo',
      '--fingerprint-transparent-proxy',
      '--fingerprint-transparent-proxy-dns=local',
      '--fingerprint-portable-cookies',
    ])
  })

  it('uses fingerprint off for a native identity and still sends explicit timezone', () => {
    const options = browserOptionsForWindow(
      '/data/profile',
      runtimeWindow({
        settings: {
          platform: '',
          note: '',
          geoip: false,
          timezone: 'Asia/Tokyo',
          locale: 'ja-JP',
          viewport: 'default',
          fingerprintSeed: 42069,
          aliasEngine: null,
          operatingSystem: 'host',
          cpuCores: null,
          startUrl: '',
          cloakbrowser: { nativeFingerprint: true },
        },
      }),
    )
    expect(options.args).toEqual([
      '--fingerprint=off',
      '--fingerprint-timezone=Asia/Tokyo',
      '--fingerprint-locale=ja-JP',
    ])
  })
})
