import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapsBuildKey } from './build-config.ts'
import { profileFields, type Profile } from './model.ts'

test('build key accepts only a configured browser key and does not require plugin settings', () => {
  assert.equal(mapsBuildKey(undefined), null)
  assert.equal(mapsBuildKey(''), null)
  assert.equal(mapsBuildKey('fixture browser key'), null)
  assert.equal(mapsBuildKey('  fixture-browser-key  '), 'fixture-browser-key')
})
test('every profile field has a separate copy value including firstname and lastname', () => {
  const profile: Profile = {
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
    latitude: 47.60621234,
    longitude: -122.33212345,
    source: 'map',
    sourceUrl: 'https://www.google.com/maps',
    approximate: true,
  }
  const fields = profileFields(profile)
  assert.deepEqual(
    new Set(fields.map((field) => field.id)),
    new Set(Object.keys(profile)),
  )
  assert.equal(fields.find((field) => field.id === 'firstName')?.value, 'Alex')
  assert.equal(fields.find((field) => field.id === 'lastName')?.value, 'Example')
  assert.equal(fields.find((field) => field.id === 'latitude')?.value, '47.60621234')
  assert.equal(fields.find((field) => field.id === 'county')?.value, '')
})
