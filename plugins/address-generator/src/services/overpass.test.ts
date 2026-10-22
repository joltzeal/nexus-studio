import { describe, expect, it, vi } from 'vitest'

import { UpstreamError } from '../domain/errors.js'
import {
  ENDPOINTS,
  PublicAddressService,
  cleanElements,
  sampleAddresses,
} from './overpass.js'
import { findCity } from './catalog.js'

const paris = findCity('paris')
if (paris === undefined) throw new Error('fixture city missing')

function node(id: number, tags: Record<string, string>, lat = 48.8566, lon = 2.3522) {
  return { type: 'node', id, lat, lon, tags }
}

const complete = {
  'addr:housenumber': '12',
  'addr:street': 'Rue de Rivoli',
  'addr:city': 'Paris',
  'addr:postcode': '75001',
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('cleanElements', () => {
  it('keeps only complete addresses', () => {
    const items = cleanElements(
      {
        elements: [
          node(1, complete),
          node(2, { ...complete, 'addr:housenumber': '' }),
          node(3, { 'addr:street': 'Rue de Rivoli' }),
          node(4, { ...complete, 'addr:postcode': '' }),
        ],
      },
      'FR',
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      houseNumber: '12',
      street: 'Rue de Rivoli',
      city: 'Paris',
      postalCode: '75001',
      countryCode: 'FR',
      source: 'osm',
      sourceUrl: 'https://www.openstreetmap.org/node/1',
    })
  })

  it('drops an address tagged with a different country', () => {
    const items = cleanElements(
      { elements: [node(1, { ...complete, 'addr:country': 'BE' })] },
      'FR',
    )
    expect(items).toHaveLength(0)
  })

  it('reads way centres and rejects out-of-range coordinates', () => {
    const items = cleanElements(
      {
        elements: [
          { type: 'way', id: 7, center: { lat: 48.85, lon: 2.35 }, tags: complete },
          { type: 'way', id: 8, center: { lat: 200, lon: 2.35 }, tags: complete },
          node(9, complete, Number.NaN),
        ],
      },
      'FR',
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.latitude).toBe(48.85)
  })

  it('de-duplicates the same building', () => {
    const items = cleanElements(
      { elements: [node(1, complete), node(2, complete)] },
      'FR',
    )
    expect(items).toHaveLength(1)
  })

  it('rejects an upstream error payload instead of returning an empty list', () => {
    expect(() => cleanElements({ remark: 'runtime error' }, 'FR')).toThrow(UpstreamError)
    expect(() => cleanElements({ elements: 'nope' }, 'FR')).toThrow(UpstreamError)
  })
})

describe('sampleAddresses', () => {
  it('never returns more than the pool and caps at 50', () => {
    const pool = Array.from({ length: 5 }, (_, index) => ({ id: index }) as never)
    expect(sampleAddresses(pool, 10)).toHaveLength(5)
    const big = Array.from({ length: 120 }, (_, index) => ({ id: index }) as never)
    expect(sampleAddresses(big, 500)).toHaveLength(50)
  })

  it('does not mutate the cached pool', () => {
    const pool = Array.from({ length: 5 }, (_, index) => ({ id: index }) as never)
    const before = pool.map((entry) => (entry as { id: number }).id)
    sampleAddresses(pool, 5)
    expect(pool.map((entry) => (entry as { id: number }).id)).toEqual(before)
  })
})

describe('PublicAddressService', () => {
  it('parses a healthy response and caches it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ elements: [node(1, complete)] }))
    const service = new PublicAddressService({ fetchImpl, now: () => 1_000 })
    const first = await service.list(paris)
    expect(first.cached).toBe(false)
    expect(first.items).toHaveLength(1)
    expect(first.endpoint).toBe(ENDPOINTS[0].url)

    const second = await service.list(paris)
    expect(second.cached).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('fails over to the second mirror', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === ENDPOINTS[0].url) return jsonResponse({ error: 'busy' }, 503)
      return jsonResponse({ elements: [node(1, complete)] })
    })
    const service = new PublicAddressService({ fetchImpl, now: () => 5_000 })
    const result = await service.list(paris)
    expect(result.endpoint).toBe(ENDPOINTS[1].url)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('reports the upstream reason when every mirror fails', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'busy' }, 429))
    const service = new PublicAddressService({ fetchImpl, now: () => 9_000 })
    await expect(service.list(paris)).rejects.toMatchObject({ reason: 'rate-limit' })
  })

  it('applies the cooldown between different cities', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ elements: [node(1, complete)] }))
    const service = new PublicAddressService({ fetchImpl, now: () => 20_000 })
    await service.list(paris)
    const lyon = findCity('lyon')
    if (lyon === undefined) throw new Error('fixture city missing')
    await expect(service.list(lyon)).rejects.toMatchObject({ reason: 'rate-limit' })
  })

  it('serves one request for concurrent calls about the same city', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ elements: [node(1, complete)] }))
    const service = new PublicAddressService({ fetchImpl, now: () => 30_000 })
    const [left, right] = await Promise.all([service.list(paris), service.list(paris)])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(left.items).toHaveLength(1)
    expect(right.items).toHaveLength(1)
  })
})
