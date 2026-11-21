import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPickerSession, type PickState } from './picker-session.ts'
import { normalizeGoogleAddress } from './google-geocode.ts'

function geocoded(house = '12') {
  return {
    types: ['street_address'],
    place_id: 'fixture',
    address_components: [
      ['route', 'Example Avenue', 'Example Avenue'],
      ['street_number', house, house],
      ['locality', 'Seattle', 'Seattle'],
      ['postal_code', '98101', '98101'],
      ['country', 'United States', 'US'],
    ].map(([type, long_name, short_name]) => ({
      types: [type!],
      long_name: long_name!,
      short_name: short_name!,
    })),
    geometry: {
      location: { lat: () => 47.6062, lng: () => -122.3321 },
      location_type: 'ROOFTOP',
    },
  }
}
test('geocoding requires a building, door number, postcode and matching country', () => {
  assert.equal(normalizeGoogleAddress([geocoded()], 'US')?.source, 'map')
  assert.equal(normalizeGoogleAddress([geocoded()], 'FR'), null)
  assert.equal(normalizeGoogleAddress([{ ...geocoded(), types: ['route'] }], 'US'), null)
  assert.equal(normalizeGoogleAddress([geocoded('')], 'US'), null)
  assert.equal(
    normalizeGoogleAddress(
      [
        {
          ...geocoded(),
          geometry: { ...geocoded().geometry, location_type: 'RANGE_INTERPOLATED' },
        },
      ],
      'US',
    )?.approximate,
    true,
  )
})
test('rapid picks never prepare a stale address or replace the latest selection', async () => {
  const states: PickState[] = []
  let resolveFirst!: (value: ReturnType<typeof normalizeGoogleAddress>) => void
  const first = new Promise<ReturnType<typeof normalizeGoogleAddress>>((resolve) => {
    resolveFirst = resolve
  })
  const prepared: string[] = []
  const session = createPickerSession(
    async (address) => {
      prepared.push(address.houseNumber)
      return {
        ...address,
        id: address.houseNumber,
        firstName: 'Alex',
        lastName: 'Example',
        username: 'alex.example',
      }
    },
    (state) => states.push(state),
  )
  const old = session.select(() => first)
  await session.select(async () => normalizeGoogleAddress([geocoded('14')], 'US'))
  resolveFirst(normalizeGoogleAddress([geocoded('12')], 'US'))
  await old
  assert.deepEqual(prepared, ['14'])
  assert.equal(states.at(-1)?.profile?.houseNumber, '14')
})
test('disposing the map invalidates in-flight identity generation', async () => {
  const states: PickState[] = []
  let finish!: (value: never) => void
  const session = createPickerSession(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
    (state) => states.push(state),
  )
  const pending = session.select(async () => normalizeGoogleAddress([geocoded()], 'US'))
  await Promise.resolve()
  session.dispose()
  finish({} as never)
  await pending
  assert.deepEqual(
    states.map((state) => state.status),
    ['loading'],
  )
})
