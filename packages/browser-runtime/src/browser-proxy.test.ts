import { buildLaunchOptions } from 'cloakbrowser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareBrowserProxy } from './browser-proxy.js'

vi.mock('cloakbrowser', () => ({ buildLaunchOptions: vi.fn() }))

let controller: AbortController

beforeEach(() => {
  controller = new AbortController()
  vi.mocked(buildLaunchOptions)
    .mockReset()
    .mockResolvedValue({
      args: [
        '--fingerprint-timezone=Europe/London',
        '--lang=en-GB',
        '--fingerprint-locale=en-GB',
        '--fingerprint-webrtc-ip=81.2.69.160',
        '--proxy-server=http://proxy.example:8080',
      ],
    })
})

afterEach(() => controller.abort())

it('resolves GeoIP before launch and retains the resolved locale, timezone and egress override', async () => {
  const options = await prepareBrowserProxy(
    {
      userDataDir: '/unused',
      proxy: 'http://proxy.example:8080',
      geoip: true,
      timezone: 'Europe/London',
      locale: 'en-GB',
    },
    controller.signal,
  )
  expect(buildLaunchOptions).toHaveBeenCalledWith(
    expect.objectContaining({ geoip: true, timezone: 'Europe/London', locale: 'en-GB' }),
  )
  expect(options.geoip).toBe(false)
  expect(options.args).toContain('--fingerprint-webrtc-ip=81.2.69.160')
  expect(options.args).toContain('--fingerprint-timezone=Europe/London')
  expect(options.args).toContain('--fingerprint-locale=en-GB')
  expect(options.args).not.toContain('--proxy-server=http://proxy.example:8080')
  expect(options.proxy).toBe('http://proxy.example:8080')
})

it.each([undefined, 'auto', '127.0.0.1', '::1'])(
  'fails explicitly when enabled matching lacks a real egress override (%s)',
  async (exitIp) => {
    vi.mocked(buildLaunchOptions).mockResolvedValue({
      args: exitIp ? [`--fingerprint-webrtc-ip=${exitIp}`] : [],
    })
    await expect(
      prepareBrowserProxy(
        {
          userDataDir: '/unused',
          proxy: 'http://proxy.example:8080',
          geoip: true,
          timezone: 'Europe/London',
          locale: 'en-GB',
        },
        controller.signal,
      ),
    ).rejects.toThrow('PROFILE_GEOIP_EXIT_IP_REQUIRED')
  },
)

it('keeps explicitly disabled GeoIP free of resolution requests', async () => {
  const input = {
    userDataDir: '/unused',
    proxy: 'http://proxy.example:8080',
    geoip: false,
  }
  expect(await prepareBrowserProxy(input, controller.signal)).toEqual(input)
  expect(buildLaunchOptions).not.toHaveBeenCalled()
})
