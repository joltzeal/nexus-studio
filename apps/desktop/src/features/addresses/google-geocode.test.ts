import { describe, expect, it } from 'vitest'
import { normalizeGoogleAddress } from './google-geocode'

interface ComponentSpec {
  type: string
  long: string
  short?: string
}

function result(
  components: ComponentSpec[],
  overrides: {
    types?: string[]
    locationType?: string
    latitude?: number
    longitude?: number
    placeId?: string
  } = {},
): google.maps.GeocoderResult {
  return {
    types: overrides.types ?? ['street_address'],
    place_id: overrides.placeId ?? 'place-1',
    address_components: components.map((component) => ({
      types: [component.type],
      long_name: component.long,
      short_name: component.short ?? component.long,
    })),
    geometry: {
      location: {
        lat: () => overrides.latitude ?? 48.8566,
        lng: () => overrides.longitude ?? 2.3522,
      },
      location_type: overrides.locationType ?? 'ROOFTOP',
    },
  }
}

const paris: ComponentSpec[] = [
  { type: 'street_number', long: '12' },
  { type: 'route', long: 'Rue de Rivoli' },
  { type: 'locality', long: 'Paris' },
  { type: 'postal_code', long: '75001' },
  { type: 'administrative_area_level_1', long: 'Île-de-France', short: 'IDF' },
  { type: 'country', long: 'France', short: 'FR' },
]

describe('normalizeGoogleAddress', () => {
  it('reads a building-level result', () => {
    expect(normalizeGoogleAddress([result(paris)], 'FR')).toEqual({
      street: 'Rue de Rivoli',
      houseNumber: '12',
      city: 'Paris',
      postalCode: '75001',
      countryCode: 'FR',
      state: 'Île-de-France',
      county: null,
      latitude: 48.8566,
      longitude: 2.3522,
      source: 'map',
      sourceUrl:
        'https://www.google.com/maps/search/?api=1&query=48.8566,2.3522&query_place_id=place-1',
      approximate: false,
    })
  })

  it('keeps the US county and reports an approximate position', () => {
    const us = normalizeGoogleAddress(
      [
        result(
          [
            { type: 'street_number', long: '350' },
            { type: 'route', long: '5th Ave' },
            { type: 'locality', long: 'New York' },
            { type: 'postal_code', long: '10118' },
            { type: 'administrative_area_level_1', long: 'New York', short: 'NY' },
            { type: 'administrative_area_level_2', long: 'New York County' },
            { type: 'country', long: 'United States', short: 'US' },
          ],
          { locationType: 'RANGE_INTERPOLATED' },
        ),
      ],
      'US',
    )
    expect(us?.state).toBe('New York')
    expect(us?.county).toBe('New York County')
    expect(us?.approximate).toBe(true)
  })

  it('skips a result in another country', () => {
    expect(normalizeGoogleAddress([result(paris)], 'DE')).toBeNull()
  })

  it('skips a result without a house number', () => {
    const withoutNumber = paris.filter((part) => part.type !== 'street_number')
    expect(normalizeGoogleAddress([result(withoutNumber)], 'FR')).toBeNull()
  })

  it('skips street-level and postcode-level matches', () => {
    expect(
      normalizeGoogleAddress([result(paris, { types: ['route', 'political'] })], 'FR'),
    ).toBeNull()
  })

  it('uses the postal town when there is no locality', () => {
    const london: ComponentSpec[] = [
      { type: 'street_number', long: '10' },
      { type: 'route', long: 'Downing Street' },
      { type: 'postal_town', long: 'London' },
      { type: 'postal_code', long: 'SW1A 2AA' },
      { type: 'country', long: 'United Kingdom', short: 'GB' },
    ]
    expect(normalizeGoogleAddress([result(london)], 'GB')?.city).toBe('London')
  })

  it('rejects an out-of-range coordinate', () => {
    expect(normalizeGoogleAddress([result(paris, { latitude: 120 })], 'FR')).toBeNull()
  })
})
