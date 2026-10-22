import { describe, expect, it } from 'vitest'

import {
  addressKey,
  addressText,
  profileText,
  profilesCsv,
  streetLine,
  type ProfileRecord,
} from './address.js'

const profile: ProfileRecord = {
  id: 'p1',
  firstName: 'Marie',
  lastName: 'Laurent',
  username: 'marie.laurent94',
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

describe('addressKey', () => {
  it('treats case, width and repeated spaces as the same address', () => {
    const left = addressKey(profile)
    const right = addressKey({
      ...profile,
      street: '  RUE   DE RIVOLI ',
      city: 'paris',
    })
    expect(right).toBe(left)
  })

  it('separates different house numbers', () => {
    expect(addressKey({ ...profile, houseNumber: '14' })).not.toBe(addressKey(profile))
  })
})

describe('addressText', () => {
  it('uses the European order by default', () => {
    expect(addressText(profile)).toBe('12 Rue de Rivoli\n75001 Paris\nFR')
  })

  it('puts the state before the postcode for the US', () => {
    expect(
      addressText({
        ...profile,
        countryCode: 'US',
        city: 'New York',
        state: 'NY',
        postalCode: '10001',
      }),
    ).toBe('12 Rue de Rivoli\nNew York, NY 10001\nUS')
  })

  it('omits a missing state instead of printing a comma', () => {
    expect(
      addressText({
        ...profile,
        countryCode: 'US',
        city: 'New York',
        postalCode: '10001',
      }),
    ).toBe('12 Rue de Rivoli\nNew York 10001\nUS')
  })

  it('keeps the handle on its own line', () => {
    expect(profileText(profile).split('\n').slice(0, 2)).toEqual([
      'Marie Laurent',
      'marie.laurent94',
    ])
  })

  it('builds the street line from number and street', () => {
    expect(streetLine(profile)).toBe('12 Rue de Rivoli')
  })
})

describe('profilesCsv', () => {
  it('writes a BOM, a header and one row per profile', () => {
    const csv = profilesCsv([profile])
    const lines = csv.replace('\uFEFF', '').split('\r\n')
    expect(lines[0]).toBe(
      'firstName,lastName,username,houseNumber,street,city,postalCode,state,county,countryCode,latitude,longitude,source,sourceUrl,approximate',
    )
    expect(lines[1]).toContain('"marie.laurent94"')
    expect(lines).toHaveLength(2)
  })

  it('escapes quotes and neutralises formula prefixes', () => {
    const csv = profilesCsv([{ ...profile, lastName: '=HYPERLINK("x")' }])
    expect(csv).toContain('"\'=HYPERLINK(""x"")"')
  })
})
