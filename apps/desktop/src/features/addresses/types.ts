/**
 * Shapes returned by the address generator plugin. They mirror
 * `plugins/address-generator` (`AddressRecord`, `ProfileRecord`, catalog rows)
 * field by field; the plugin is the only writer, the page never invents fields.
 */

export const ADDRESS_PLUGIN_ID = 'studio.address-generator'
export const ADDRESS_CAPABILITY = 'address.generator'

export const MAX_RESULTS = 50

export type AddressSource = 'osm' | 'map'

export interface CountryOption {
  code: string
  label: string
}

export interface CityOption {
  id: string
  name: string
  country: string
  latitude: number
  longitude: number
}

export interface AddressCatalog {
  countries: CountryOption[]
  cities: CityOption[]
}

export interface AddressRecord {
  street: string
  houseNumber: string
  city: string
  postalCode: string
  countryCode: string
  state: string | null
  county: string | null
  latitude: number
  longitude: number
  source: AddressSource
  sourceUrl: string
  approximate: boolean
}

export interface Profile extends AddressRecord {
  id: string
  firstName: string
  lastName: string
  username: string
}

export interface GenerateResult {
  items: Profile[]
  requested: number
  found: number
  poolSize: number
  endpoint: string
  cached: boolean
}

export interface MapsConfig {
  hasApiKey: boolean
  /** Present only because the page has to hand it to the Maps SDK. */
  apiKey: string | null
  storageDurable: boolean
}

export function message(error: unknown): string {
  return typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '操作失败，请重试。'
}

export function streetLine(address: AddressRecord): string {
  return `${address.houseNumber} ${address.street}`.trim()
}

/** Same ordering rules as the plugin, so a card and the copied text agree. */
export function addressText(address: AddressRecord): string {
  if (address.countryCode === 'US') {
    const region = address.state === null ? '' : `, ${address.state}`
    return `${streetLine(address)}\n${address.city}${region} ${address.postalCode}\nUS`
  }
  return `${streetLine(address)}\n${address.postalCode} ${address.city}\n${address.countryCode}`
}

export function profileText(profile: Profile): string {
  return `${profile.firstName} ${profile.lastName}\n${profile.username}\n${addressText(profile)}`
}

/** Identity of an address, used to refuse the same pick twice. */
export function addressKey(address: AddressRecord): string {
  return [
    address.countryCode,
    address.state ?? '',
    address.postalCode,
    address.city,
    streetLine(address),
  ]
    .map((value) =>
      value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en'),
    )
    .join('|')
}

export function sourceLabel(source: AddressSource): string {
  return source === 'map' ? '地图选点' : 'OpenStreetMap'
}
