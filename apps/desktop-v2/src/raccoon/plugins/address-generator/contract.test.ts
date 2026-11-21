import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAddressApi } from './api.ts'
import {
  ADDRESS_METHODS,
  supportsAddressPage,
  supportsAddressFeature,
} from './page-contract.ts'
import { parseCatalog, parseProfile, parseSavedPage } from './parse.ts'

export const profile = {
  id: 'profile-1',
  firstName: 'Alex',
  lastName: 'Example',
  username: 'alex.example',
  street: 'Example Avenue',
  houseNumber: '12',
  city: 'Seattle',
  postalCode: '98101',
  countryCode: 'US',
  state: 'WA',
  county: null,
  latitude: 47.6062,
  longitude: -122.3321,
  source: 'map' as const,
  sourceUrl: '',
  approximate: false,
}
test('map page never requires public generation and gates optional workflows independently', () => {
  const plugin = {
    id: 'studio.address-generator',
    capabilities: ['address.generator'],
    granted: ['address.generator'],
    methods: [...ADDRESS_METHODS.base],
    enabled: true,
    state: 'running',
  }
  assert.equal(supportsAddressPage(plugin), true)
  assert.equal(new Set<string>(plugin.methods).has('address.generate'), false)
  assert.equal(supportsAddressPage({ ...plugin, granted: [] }), false)
  assert.equal(supportsAddressFeature(plugin, 'saved'), false)
  assert.equal(
    supportsAddressFeature(
      { ...plugin, methods: [...plugin.methods, ...ADDRESS_METHODS.saved] },
      'saved',
    ),
    true,
  )
})
test('rejects malformed catalog, incomplete address, non-finite coordinates and config flags', () => {
  assert.throws(() =>
    parseCatalog({
      countries: [{ code: 'US', label: 'US' }],
      cities: [{ id: 'one', name: 'One', country: 'FR', latitude: 1, longitude: 2 }],
    }),
  )
  assert.throws(() => parseProfile({ ...profile, postalCode: '' }))
  assert.throws(() => parseProfile({ ...profile, latitude: NaN }))
  assert.deepEqual(parseProfile(profile), profile)
})
test('saved pages require coherent pagination, durable flag and distinct complete profiles', () => {
  const item = { ...profile, savedAt: '2026-11-19T01:00:00.000Z' }
  const page = { items: [item], total: 1, page: 1, pageSize: 20, storageDurable: true }
  assert.equal(parseSavedPage(page).items[0]?.id, profile.id)
  assert.throws(() => parseSavedPage({ ...page, total: 0 }))
  assert.throws(() => parseSavedPage({ ...page, storageDurable: 'true' }))
  assert.throws(() => parseSavedPage({ ...page, items: [item, item], total: 2 }))
  assert.throws(() =>
    parseSavedPage({ ...page, items: [{ ...item, savedAt: 'yesterday' }] }),
  )
})
test('RPC saves accept canonical deduplicated identities and strip saved metadata', async () => {
  let payload: unknown
  const api = createAddressApi(async (id, capability, method, input, parse) => {
    assert.equal(id, 'studio.address-generator')
    assert.equal(capability, 'address.generator')
    assert.equal(method, 'address.saved.save')
    payload = input
    return parse({
      item: { ...profile, id: 'canonical', savedAt: '2026-11-19T01:00:00.000Z' },
      created: false,
      storageDurable: true,
    })
  })
  const saved = await api.save({ ...profile, savedAt: '2026-11-19T01:00:00.000Z' })
  assert.equal(saved.item.id, 'canonical')
  assert.deepEqual(payload, { profile })
})
test('a save response for a different address cannot be reported as success', async () => {
  const api = createAddressApi(async (_id, _capability, _method, _input, parse) =>
    parse({
      item: { ...profile, street: 'Other Street', savedAt: '2026-11-19T01:00:00.000Z' },
      created: true,
      storageDurable: true,
    }),
  )
  await assert.rejects(api.save(profile))
})
