import { describe, expect, it } from 'vitest'
import type { BrowserWindow } from '@/lib/platform/windows'
import { browserWindow } from '@/lib/platform/browser-test-support'
import { configOf, parseWindowConfig } from './window-config'

const CONFIG_KEYS = [
  'proxy',
  'geoip',
  'timezone',
  'locale',
  'viewport',
  'fingerprintSeed',
  'startUrl',
]

function profile(overrides: Partial<BrowserWindow> = {}): BrowserWindow {
  return {
    ...browserWindow(),
    id: 'p1',
    name: 'Window',
    version: '155.0.1.2',
    proxy: null,
    proxyPlugin: null,
    proxyEndpoint: null,
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
    expect(config.geoip).toBe(true)
    expect(config.fingerprintSeed).toBeGreaterThan(0)
    expect(config.fingerprintSeed).toBeLessThanOrEqual(2147483647)
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
    expect(config.geoip).toBe(false)
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
    expect(configOf(profile({ proxy: 'https://host:8443' })).proxy).toEqual({
      protocol: 'https',
      server: 'https://host:8443',
    })
  })

  it.each(['http', 'https', 'socks5'])(
    'preserves the full authenticated %s URL through validation',
    (protocol) => {
      const server = `${protocol}://fixture%40user:fixture%3Apass@proxy.test:1080`
      const config = configOf(profile({ proxy: server }))
      expect(config.proxy.protocol).toBe(protocol)
      expect(parseWindowConfig(config).proxy.server).toBe(server)
    },
  )

  it.each([
    ['http', 'http://fixture-user:fixture-pass@proxy.test:80/'],
    ['https', 'https://fixture-user:fixture-pass@proxy.test:443'],
    ['socks5', 'socks5://fixture-user:fixture-pass@[::1]:1080'],
  ])('preserves explicit ports and URL syntax for %s', (protocol, server) => {
    expect(
      parseWindowConfig({ ...configOf(null), proxy: { protocol, server } }).proxy.server,
    ).toBe(server)
  })

  it.each([
    { proxy: { protocol: 'https', server: 'http://proxy.test:8080' } },
    { proxy: { protocol: 'socks5h', server: 'socks5h://proxy.test:1080' } },
    { proxy: { protocol: 'http', server: 'http://proxy.test' } },
    { proxy: { protocol: 'http', server: 'http://proxy.test:0' } },
    { proxy: { protocol: 'https', server: 'https://proxy.test:65536' } },
    { proxy: { protocol: 'http', server: 'http://proxy.test:80/path' } },
    { proxy: { protocol: 'http', server: 'http://proxy.test:80?route=x' } },
    { proxy: { protocol: 'http', server: 'http://proxy.test:80#x' } },
    { proxy: { protocol: 'direct', server: 'http://proxy.test:80' } },
    { proxy: { protocol: 'direct', server: '', username: 'unexpected' } },
    { unknownSetting: true },
    { fingerprintSeed: 0 },
    { timezone: 'Invalid/Region' },
    { locale: 'invalid_locale' },
    { startUrl: 'file:///private/data' },
  ])('rejects invalid current form configuration: %j', (changes) => {
    expect(() => parseWindowConfig({ ...configOf(null), ...changes })).toThrow()
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
