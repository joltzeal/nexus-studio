import { Response, fetch as proxyFetch } from 'undici'
import { beforeEach, expect, it, vi } from 'vitest'
import { resolveOnlineProxyGeo } from './online-proxy-geo.js'

vi.mock('undici', async (original) => ({
  ...(await original<typeof import('undici')>()),
  fetch: vi.fn(),
}))

const proxy = 'http://account:synthetic-secret@proxy.invalid:8080'
const primary = {
  success: true,
  ip: '81.2.69.160',
  country_code: 'GB',
  timezone: { id: 'Europe/London' },
}
const fallback = {
  ip: '81.2.69.160',
  country_code: 'GB',
  timezone: 'Europe/London',
}
const json = (value: unknown) => new Response(JSON.stringify(value))

beforeEach(() => {
  vi.mocked(proxyFetch).mockReset()
})

it('gets the exit IP, timezone and locale online with an explicit proxy dispatcher', async () => {
  vi.mocked(proxyFetch).mockResolvedValue(json(primary))
  await expect(
    resolveOnlineProxyGeo(proxy, new AbortController().signal),
  ).resolves.toEqual({
    ip: '81.2.69.160',
    timezone: 'Europe/London',
    locale: 'en-GB',
  })
  expect(proxyFetch).toHaveBeenCalledTimes(1)
  expect(proxyFetch).toHaveBeenCalledWith(
    expect.stringContaining('https://ipwho.is/'),
    expect.objectContaining({ dispatcher: expect.any(Object), redirect: 'error' }),
  )
})

it('uses a second provider when the first provider rate limits the proxy exit', async () => {
  vi.mocked(proxyFetch)
    .mockResolvedValueOnce(new Response('', { status: 429 }))
    .mockResolvedValueOnce(json(fallback))
  await expect(
    resolveOnlineProxyGeo(proxy, new AbortController().signal),
  ).resolves.toMatchObject({
    ip: primary.ip,
    timezone: 'Europe/London',
  })
  expect(proxyFetch).toHaveBeenNthCalledWith(
    2,
    'https://api.ip.sb/geoip',
    expect.objectContaining({ dispatcher: expect.any(Object) }),
  )
})

it.each([
  { ...primary, ip: 'not-an-ip' },
  { ...primary, ip: '127.0.0.1' },
  { ...primary, timezone: { id: 'invalid/timezone' } },
  { ...primary, success: false },
])('does not turn an invalid online answer into a fingerprint (%j)', async (invalid) => {
  vi.mocked(proxyFetch)
    .mockResolvedValueOnce(json(invalid))
    .mockResolvedValueOnce(json(fallback))
  await expect(
    resolveOnlineProxyGeo(proxy, new AbortController().signal),
  ).resolves.toMatchObject({
    ip: primary.ip,
    timezone: 'Europe/London',
  })
  expect(proxyFetch).toHaveBeenCalledTimes(2)
})

it('only requires an exit IP when timezone and locale were provided manually', async () => {
  vi.mocked(proxyFetch).mockResolvedValue(json({ success: true, ip: primary.ip }))
  await expect(
    resolveOnlineProxyGeo(proxy, new AbortController().signal, {
      requireTimezone: false,
      requireLocale: false,
    }),
  ).resolves.toEqual({ ip: primary.ip, timezone: undefined, locale: undefined })
})

it('keeps proxy failures distinct from unavailable online services without exposing credentials', async () => {
  vi.mocked(proxyFetch).mockRejectedValue(
    new TypeError(`failed to fetch ${proxy}`, { cause: { code: 'ECONNREFUSED' } }),
  )
  await expect(
    resolveOnlineProxyGeo(proxy, new AbortController().signal),
  ).rejects.toThrow('PROFILE_GEO_PROXY_CONNECT_FAILED')
  vi.mocked(proxyFetch).mockResolvedValue(new Response('', { status: 429 }))
  await expect(
    resolveOnlineProxyGeo(proxy, new AbortController().signal),
  ).rejects.toThrow('PROFILE_GEO_ONLINE_UNAVAILABLE')
})

it('aborts an active lookup without trying another provider or switching to direct', async () => {
  const controller = new AbortController()
  vi.mocked(proxyFetch).mockImplementation(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('cancelled')))
        controller.abort()
      }),
  )
  await expect(resolveOnlineProxyGeo(proxy, controller.signal)).rejects.toThrow()
  expect(proxyFetch).toHaveBeenCalledTimes(1)
})

it('bounds each online request and falls back after a stalled provider', async () => {
  vi.mocked(proxyFetch)
    .mockImplementationOnce(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('timed out')))
        }),
    )
    .mockResolvedValueOnce(json(fallback))
  await expect(
    resolveOnlineProxyGeo(proxy, new AbortController().signal, { timeoutMs: 20 }),
  ).resolves.toMatchObject({ ip: primary.ip })
})
