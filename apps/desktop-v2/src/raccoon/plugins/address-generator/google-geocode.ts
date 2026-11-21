import type { Address } from './model.ts'

export interface GeocodedAddress {
  types: string[]
  place_id: string
  address_components: { types: string[]; long_name: string; short_name: string }[]
  geometry: { location: { lat(): number; lng(): number }; location_type: string }
}
export function normalizeGoogleAddress(
  results: readonly GeocodedAddress[],
  countryCode: string,
): Address | null {
  for (const result of results) {
    if (
      !result.types.some((type) =>
        ['street_address', 'premise', 'subpremise'].includes(type),
      )
    )
      continue
    const part = (type: string, short = false) => {
      const component = result.address_components.find((entry) =>
        entry.types.includes(type),
      )
      return (short ? component?.short_name : component?.long_name)?.trim() ?? ''
    }
    const street = part('route'),
      houseNumber = part('street_number'),
      city = part('locality') || part('postal_town'),
      postalCode = part('postal_code')
    if (
      !street ||
      !houseNumber ||
      !city ||
      !postalCode ||
      part('country', true) !== countryCode
    )
      continue
    const latitude = result.geometry.location.lat(),
      longitude = result.geometry.location.lng()
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    )
      continue
    return {
      street,
      houseNumber,
      city,
      postalCode,
      countryCode,
      state: part('administrative_area_level_1') || null,
      county: countryCode === 'US' ? part('administrative_area_level_2') || null : null,
      latitude,
      longitude,
      source: 'map',
      sourceUrl: `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}&query_place_id=${encodeURIComponent(result.place_id)}`,
      approximate: result.geometry.location_type !== 'ROOFTOP',
    }
  }
  return null
}
