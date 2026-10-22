import { describe, expect, it } from 'vitest'

import { AddressGenerator } from './address-generator.js'
import type { AddressRecord } from '../domain/address.js'
import { isPluginFailure } from '../domain/errors.js'
import type { DispatchContext } from '../rpc/protocol.js'
import { Redactor, createLogger } from '../rpc/redact.js'
import { PublicAddressService } from '../services/overpass.js'
import { createMemoryStore } from '../store/private-store.js'
import { createMemoryVault } from '../store/secret-vault.js'

const parisAddress: AddressRecord = {
  street: 'Rue de Rivoli',
  houseNumber: '12',
  city: 'Paris',
  postalCode: '75001',
  countryCode: 'FR',
  state: null,
  county: null,
  latitude: 48.8566,
  longitude: 2.3522,
  source: 'osm',
  sourceUrl: 'https://www.openstreetmap.org/node/1',
  approximate: false,
}

function createGenerator(overrides: { items?: AddressRecord[] } = {}) {
  const redactor = new Redactor()
  const lookup = {
    list: async () => ({
      items: overrides.items ?? [parisAddress, { ...parisAddress, houseNumber: '14' }],
      endpoint: 'https://overpass-api.de/api/interpreter',
      cached: false,
    }),
  } as unknown as PublicAddressService
  const store = createMemoryStore()
  const vault = createMemoryVault(redactor)
  let sequence = 0
  const plugin = new AddressGenerator({
    store,
    vault,
    lookup,
    logger: createLogger(() => undefined, redactor),
    random: () => 0.42,
    idFactory: () => `id-${++sequence}`,
  })
  return { plugin, store, vault }
}

function context(method: string, payload: unknown = {}): DispatchContext {
  return {
    requestId: 'request-1',
    capability: 'address.generator',
    method,
    payload,
    deadlineAt: Date.now() + 5_000,
    assertAlive: () => undefined,
  }
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (isPluginFailure(error)) return error
    throw error
  }
  throw new Error('expected the call to fail')
}

describe('AddressGenerator', () => {
  it('exposes the catalog it can actually serve', async () => {
    const { plugin } = createGenerator()
    const result = (await plugin.call(context('address.catalog'))) as {
      countries: { code: string; label: string }[]
      cities: { id: string; country: string; latitude: number }[]
    }
    expect(result.countries).toHaveLength(10)
    expect(result.cities).toHaveLength(30)
    expect(result.cities.every((city) => city.latitude !== 0)).toBe(true)
  })

  it('generates the requested number of profiles with unique handles', async () => {
    const { plugin } = createGenerator({
      items: Array.from({ length: 6 }, (_, index) => ({
        ...parisAddress,
        houseNumber: String(10 + index),
      })),
    })
    const result = (await plugin.call(
      context('address.generate', { country: 'FR', cityId: 'paris', count: 4 }),
    )) as {
      items: { username: string; firstName: string; id: string }[]
      requested: number
      found: number
    }
    expect(result.requested).toBe(4)
    expect(result.found).toBe(4)
    expect(result.items).toHaveLength(4)
    const handles = new Set(result.items.map((item) => item.username))
    expect(handles.size).toBe(4)
    expect(new Set(result.items.map((item) => item.id)).size).toBe(4)
  })

  it('reports fewer results when the pool is smaller than the request', async () => {
    const { plugin } = createGenerator({ items: [parisAddress] })
    const result = (await plugin.call(
      context('address.generate', { country: 'FR', cityId: 'paris', count: 5 }),
    )) as { found: number; requested: number }
    expect(result.found).toBe(1)
    expect(result.requested).toBe(5)
  })

  it('refuses a city that belongs to another country', async () => {
    const { plugin } = createGenerator()
    const error = await failure(
      plugin.call(
        context('address.generate', { country: 'DE', cityId: 'paris', count: 1 }),
      ),
    )
    expect(error.code).toBe('INVALID_REQUEST')
  })

  it('refuses an out-of-range count', async () => {
    const { plugin } = createGenerator()
    const error = await failure(
      plugin.call(
        context('address.generate', { country: 'FR', cityId: 'paris', count: 51 }),
      ),
    )
    expect(error.code).toBe('INVALID_REQUEST')
  })

  it('turns a map pick into a profile', async () => {
    const { plugin } = createGenerator()
    const result = (await plugin.call(
      context('address.profile', {
        address: { ...parisAddress, source: 'map', approximate: true },
      }),
    )) as { item: { username: string; firstName: string; approximate: boolean } }
    expect(result.item.username).toMatch(/^[a-z][a-z0-9._-]{3,19}$/)
    expect(result.item.firstName.length).toBeGreaterThan(1)
    expect(result.item.approximate).toBe(true)
  })

  it('rejects a map pick with an incomplete address', async () => {
    const { plugin } = createGenerator()
    const error = await failure(
      plugin.call(
        context('address.profile', { address: { ...parisAddress, postalCode: '' } }),
      ),
    )
    expect(error.code).toBe('INVALID_REQUEST')
  })

  it('formats CSV for the page to copy', async () => {
    const { plugin } = createGenerator()
    const generated = (await plugin.call(
      context('address.generate', { country: 'FR', cityId: 'paris', count: 1 }),
    )) as { items: unknown[] }
    const result = (await plugin.call(
      context('address.csv', { items: generated.items }),
    )) as { text: string; count: number }
    expect(result.count).toBe(1)
    expect(result.text.startsWith('\uFEFFfirstName')).toBe(true)
  })

  it('refuses to export a file without a durable store', async () => {
    const { plugin } = createGenerator()
    const generated = (await plugin.call(
      context('address.generate', { country: 'FR', cityId: 'paris', count: 1 }),
    )) as { items: unknown[] }
    const error = await failure(
      plugin.call(context('address.export', { items: generated.items })),
    )
    expect(error.code).toBe('NOT_CONFIGURED')
  })

  it('keeps the map key out of the plugin document', async () => {
    const { plugin, store } = createGenerator()
    const key = 'AIzaSyExampleBrowserKey1234567890'
    const saved = (await plugin.call(context('address.config.set', { apiKey: key }))) as {
      hasApiKey: boolean
      apiKey: string | null
    }
    expect(saved.hasApiKey).toBe(true)
    expect(saved.apiKey).toBe(key)

    const document = await store.read()
    expect(typeof document.maps.apiKeyRef).toBe('string')
    expect(JSON.stringify(document)).not.toContain(key)

    const read = (await plugin.call(context('address.config.get'))) as {
      apiKey: string | null
    }
    expect(read.apiKey).toBe(key)
  })

  it('clears the key and drops the reference', async () => {
    const { plugin, store } = createGenerator()
    await plugin.call(
      context('address.config.set', { apiKey: 'AIzaSyExampleBrowserKey1234567890' }),
    )
    const cleared = (await plugin.call(
      context('address.config.set', { apiKey: null }),
    )) as {
      hasApiKey: boolean
      apiKey: string | null
    }
    expect(cleared.hasApiKey).toBe(false)
    expect(cleared.apiKey).toBeNull()
    expect((await store.read()).maps.apiKeyRef).toBeNull()
  })

  it('keeps the stored key when the field is omitted', async () => {
    const { plugin } = createGenerator()
    await plugin.call(
      context('address.config.set', { apiKey: 'AIzaSyExampleBrowserKey1234567890' }),
    )
    const unchanged = (await plugin.call(context('address.config.set', {}))) as {
      apiKey: string | null
    }
    expect(unchanged.apiKey).toBe('AIzaSyExampleBrowserKey1234567890')
  })

  it('rejects a key that is too short or contains whitespace', async () => {
    const { plugin } = createGenerator()
    const short = await failure(
      plugin.call(context('address.config.set', { apiKey: 'abc' })),
    )
    expect(short.code).toBe('INVALID_REQUEST')
    const spaced = await failure(
      plugin.call(context('address.config.set', { apiKey: 'AIzaSy Example Key 123' })),
    )
    expect(spaced.code).toBe('INVALID_REQUEST')
  })

  it('reports that the store is not durable', async () => {
    const { plugin } = createGenerator()
    const config = (await plugin.call(context('address.config.get'))) as {
      storageDurable: boolean
    }
    expect(config.storageDurable).toBe(false)
    expect(plugin.status()).toMatchObject({ storage: 'memory', storageDurable: false })
  })
})
