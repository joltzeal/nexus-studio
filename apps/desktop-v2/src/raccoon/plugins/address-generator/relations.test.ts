import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAddressRelations } from './relations.ts'
import type { Profile } from './model.ts'

const profile: Profile = {
  id: 'new-id',
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
  latitude: 47,
  longitude: -122,
  source: 'map',
  sourceUrl: '',
  approximate: false,
}
const canonical = { ...profile, id: 'saved-id', savedAt: '2026-11-19T01:00:00.000Z' }
test('association uses the saved canonical profile and the expected old address', async () => {
  const order: string[] = []
  const link = createAddressRelations(
    {
      save: async () => {
        order.push('save')
        return { item: canonical, storageDurable: true }
      },
    },
    {
      saveAddress: async (id, item, expected) => {
        order.push('link')
        assert.equal(id, 'account')
        assert.equal(item.id, 'saved-id')
        assert.equal('savedAt' in item, false)
        assert.equal(expected, 'old-address')
        return { storageDurable: true }
      },
    },
  )
  await link(
    profile,
    { id: 'account', address: { id: 'old-address' } },
    () => {
      order.push('saved')
    },
    () => true,
  )
  assert.deepEqual(order, ['save', 'saved', 'link'])
})
test('failed address save never writes account data', async () => {
  let called = false
  const link = createAddressRelations(
    {
      save: async () => {
        throw new Error('disk full')
      },
    },
    {
      saveAddress: async () => {
        called = true
        return { storageDurable: true }
      },
    },
  )
  await assert.rejects(
    link(
      profile,
      { id: 'account', address: null },
      () => {},
      () => true,
    ),
    /disk full/,
  )
  assert.equal(called, false)
})
test('account write failure preserves and reports the already saved address', async () => {
  let saved = false
  const link = createAddressRelations(
    { save: async () => ({ item: canonical, storageDurable: true }) },
    {
      saveAddress: async () => {
        throw new Error('address changed')
      },
    },
  )
  await assert.rejects(
    link(
      profile,
      { id: 'account', address: null },
      () => {
        saved = true
      },
      () => true,
    ),
    /address changed/,
  )
  assert.equal(saved, true)
})
test('leaving the dialog during a save prevents a subsequent account write', async () => {
  let current = true,
    called = false
  const link = createAddressRelations(
    {
      save: async () => {
        current = false
        return { item: canonical, storageDurable: true }
      },
    },
    {
      saveAddress: async () => {
        called = true
        return { storageDurable: true }
      },
    },
  )
  await link(
    profile,
    { id: 'account', address: null },
    () => {},
    () => current,
  )
  assert.equal(called, false)
})
