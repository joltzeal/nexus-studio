import { describe, expect, it, vi } from 'vitest'

import { createMemoryCache, isGlobalAddress, lookupIpReputation } from './reputation.js'

const now = () => new Date('2026-01-01T00:00:00.000Z')

function options(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return {
    apiKey: null,
    enabled: true,
    cacheSeconds: 3600,
    now,
    cache: createMemoryCache(),
    fetchImpl,
    ...overrides,
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const providerPayload = {
  status: 'ok',
  '45.33.32.156': {
    detections: {
      risk: 37,
      confidence: 88,
      proxy: true,
      vpn: false,
      tor: false,
      hosting: true,
      compromised: false,
      scraper: true,
    },
    location: {
      country_name: 'Germany',
      country_code: 'de',
      region_name: 'Berlin',
      city_name: 'Berlin',
    },
    network: { type: 'business', provider: 'Example ISP', asn: 'AS64500' },
  },
}

describe('IP reputation', () => {
  it('maps a provider answer into a scored observation', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(providerPayload),
    ) as unknown as typeof fetch
    const result = await lookupIpReputation('45.33.32.156', options(fetchImpl))
    expect(result.status).toBe('ok')
    expect(result.risk).toBe(37)
    expect(result.proxy).toBe(true)
    expect(result.scraper).toBe(true)
    expect(result.geo?.countryCode).toBe('DE')
    expect(result.geo?.isp).toBe('Example ISP')
  })

  it('never sends credentials and only calls the declared domain', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(providerPayload),
    ) as unknown as typeof fetch
    await lookupIpReputation('45.33.32.156', options(fetchImpl, { apiKey: 'secret-key' }))
    const call = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0]
    expect(call?.[0]).toContain('https://proxycheck.io/v3/45.33.32.156')
    expect(JSON.stringify(call?.[1].headers)).not.toContain('secret-key')
  })

  it('classifies a 429 as rate limited', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: 'quota' }, 429),
    ) as unknown as typeof fetch
    const result = await lookupIpReputation('45.33.32.156', options(fetchImpl))
    expect(result.status).toBe('rate_limited')
    expect(result.risk).toBeNull()
  })

  it('classifies a quota message on a non-200 answer', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ status: 'denied', message: 'Quota exceeded' }, 403),
    ) as unknown as typeof fetch
    const result = await lookupIpReputation('45.33.32.156', options(fetchImpl))
    expect(result.status).toBe('rate_limited')
    expect(result.error).toBe('在线风险服务额度不足')
  })

  it('reports an unreachable service instead of pretending success', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch
    const result = await lookupIpReputation('45.33.32.156', options(fetchImpl))
    expect(result.status).toBe('unavailable')
    expect(result.risk).toBeNull()
    expect(result.error).toContain('暂不可用')
  })

  it('treats a malformed payload as unavailable rather than a zero score', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ status: 'ok', '45.33.32.156': { detections: {} } }),
    ) as unknown as typeof fetch
    const result = await lookupIpReputation('45.33.32.156', options(fetchImpl))
    expect(result.status).toBe('unavailable')
    expect(result.risk).toBeNull()
  })

  it('skips the network when disabled or when the address is not global', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(providerPayload),
    ) as unknown as typeof fetch
    const disabled = await lookupIpReputation(
      '45.33.32.156',
      options(fetchImpl, { enabled: false }),
    )
    expect(disabled.status).toBe('disabled')
    const local = await lookupIpReputation('10.0.0.1', options(fetchImpl))
    expect(local.status).toBe('non_public')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('serves a repeated lookup from cache', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(providerPayload),
    ) as unknown as typeof fetch
    const shared = options(fetchImpl)
    await lookupIpReputation('45.33.32.156', shared)
    const cached = await lookupIpReputation('45.33.32.156', shared)
    expect(cached.cached).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('global address classification', () => {
  it.each(['45.33.32.156', '8.8.8.8', '2001:4860:4860::8888'])(
    'treats %s as global',
    (ip) => {
      expect(isGlobalAddress(ip)).toBe(true)
    },
  )

  it.each([
    '10.0.0.1',
    '127.0.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '::1',
    'fd00::1',
    '203.0.113.9',
  ])('treats %s as non-public', (ip) => {
    expect(isGlobalAddress(ip)).toBe(false)
  })
})
