import type { AddressRecord } from './types'

function text(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function validCoordinates(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  )
}

/**
 * Turns a geocoder result into an address record, or `null` when the point has
 * no complete address in the selected country. Only building-level results are
 * accepted: a street centre or a postcode centroid is not a deliverable address.
 */
export function normalizeGoogleAddress(
  results: readonly google.maps.GeocoderResult[],
  countryCode: string,
): AddressRecord | null {
  for (const result of results) {
    const buildingLevel = result.types.some((type) =>
      ['street_address', 'premise', 'subpremise'].includes(type),
    )
    if (!buildingLevel) continue

    const part = (type: string, short = false): string => {
      const component = result.address_components.find((entry) =>
        entry.types.includes(type),
      )
      if (component === undefined) return ''
      return text(short ? component.short_name : component.long_name)
    }

    const street = part('route')
    const houseNumber = part('street_number')
    const city = part('locality') || part('postal_town')
    const postalCode = part('postal_code')
    if (street === '' || houseNumber === '' || city === '' || postalCode === '') continue
    if (part('country', true) !== countryCode) continue

    const latitude = result.geometry.location.lat()
    const longitude = result.geometry.location.lng()
    if (!validCoordinates(latitude, longitude)) continue

    const state = part('administrative_area_level_1')
    return {
      street,
      houseNumber,
      city,
      postalCode,
      countryCode,
      state: state === '' ? null : state,
      county: countryCode === 'US' ? part('administrative_area_level_2') || null : null,
      latitude,
      longitude,
      source: 'map',
      sourceUrl: `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}&query_place_id=${encodeURIComponent(result.place_id)}`,
      // ROOFTOP means the geocoder matched the building itself.
      approximate: result.geometry.location_type !== 'ROOFTOP',
    }
  }
  return null
}
