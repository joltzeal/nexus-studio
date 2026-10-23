import { buildLaunchOptions } from 'cloakbrowser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareBrowserProxy } from './browser-proxy.js'
import { resolveOnlineProxyGeo } from './online-proxy-geo.js'

vi.mock('cloakbrowser', () => ({ buildLaunchOptions: vi.fn() }))
vi.mock('./online-proxy-geo.js', () => ({ resolveOnlineProxyGeo: vi.fn() }))

let controller: AbortController

beforeEach(() => {
  controller = new AbortController()
  vi.mocked(buildLaunchOptions).mockReset()
  vi.mocked(resolveOnlineProxyGeo).mockReset().mockResolvedValue({
    ip: '81.2.69.160',
    timezone: 'Europe/London',
    locale: 'en-GB',
  })
})

afterEach(() => controller.abort())

it('resolves online without invoking the SDK database path', async () => {
  const options = await prepareBrowserProxy(
    {
      userDataDir: '/unused',
      proxy: 'http://proxy.example:8080',
      geoip: true,
      args: ['--fingerprint=12345'],
    },
    controller.signal,
  )
  expect(resolveOnlineProxyGeo).toHaveBeenCalledWith(
    'http://proxy.example:8080',
    controller.signal,
    { requireTimezone: true, requireLocale: true },
  )
  expect(buildLaunchOptions).not.toHaveBeenCalled()
  expect(options.geoip).toBe(false)
  expect(options.args).toContain('--fingerprint-webrtc-ip=81.2.69.160')
  expect(options.args).toContain('--fingerprint=12345')
  expect(options.timezone).toBe('Europe/London')
  expect(options.locale).toBe('en-GB')
  expect(options.proxy).toBe('http://proxy.example:8080')
})

it('preserves manual timezone and locale while matching the WebRTC exit IP', async () => {
  const options = await prepareBrowserProxy(
    {
      userDataDir: '/unused',
      proxy: 'http://proxy.example:8080',
      geoip: true,
      timezone: 'America/New_York',
      locale: 'fr-FR',
    },
    controller.signal,
  )
  expect(options.timezone).toBe('America/New_York')
  expect(options.locale).toBe('fr-FR')
  expect(options.args).toContain('--fingerprint-webrtc-ip=81.2.69.160')
  expect(resolveOnlineProxyGeo).toHaveBeenCalledWith(
    expect.any(String),
    controller.signal,
    { requireTimezone: false, requireLocale: false },
  )
})

it('keeps explicitly disabled GeoIP free of resolution requests', async () => {
  const input = {
    userDataDir: '/unused',
    proxy: 'http://proxy.example:8080',
    geoip: false,
  }
  expect(await prepareBrowserProxy(input, controller.signal)).toEqual(input)
  expect(buildLaunchOptions).not.toHaveBeenCalled()
  expect(resolveOnlineProxyGeo).not.toHaveBeenCalled()
})

it('always disables SDK database lookups even if a direct profile retains the matching preference', async () => {
  const options = await prepareBrowserProxy(
    { userDataDir: '/unused', geoip: true },
    controller.signal,
  )
  expect(options.geoip).toBe(false)
  expect(resolveOnlineProxyGeo).not.toHaveBeenCalled()
  expect(buildLaunchOptions).not.toHaveBeenCalled()
})
