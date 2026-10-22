/**
 * Address and profile records are plain data. Nothing here reaches a
 * marketplace: the plugin only describes a location it read from a public
 * source, plus the synthetic identity the page asked for.
 */
export type AddressSource = 'osm' | 'map'

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
  /** True when the coordinate is interpolated or a building centre. */
  approximate: boolean
}

export interface ProfileRecord extends AddressRecord {
  id: string
  firstName: string
  lastName: string
  username: string
}

export function streetLine(address: AddressRecord): string {
  return `${address.houseNumber} ${address.street}`.trim()
}

/**
 * Identity of an address for de-duplication. Case, width and repeated spaces
 * are normalised so the same building never lands twice in one result set.
 */
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

/** US mail order puts the state before the postcode; EU puts it after the city. */
export function addressText(address: AddressRecord): string {
  if (address.countryCode === 'US') {
    const region = address.state === null ? '' : `, ${address.state}`
    return `${streetLine(address)}\n${address.city}${region} ${address.postalCode}\nUS`
  }
  return `${streetLine(address)}\n${address.postalCode} ${address.city}\n${address.countryCode}`
}

export function profileText(profile: ProfileRecord): string {
  return `${profile.firstName} ${profile.lastName}\n${profile.username}\n${addressText(profile)}`
}

const CSV_FIELDS = [
  'firstName',
  'lastName',
  'username',
  'houseNumber',
  'street',
  'city',
  'postalCode',
  'state',
  'county',
  'countryCode',
  'latitude',
  'longitude',
  'source',
  'sourceUrl',
  'approximate',
] as const

function escapeCsv(value: unknown): string {
  const raw = value == null ? '' : String(value)
  // A leading =, +, - or @ turns a cell into a formula in spreadsheet apps.
  const safe = /^[\s]*[=+\-@]|^[\t\r\n]/.test(raw) ? `'${raw}` : raw
  return `"${safe.replace(/"/g, '""')}"`
}

/** BOM + CRLF so Excel opens non-ASCII names without a manual import step. */
export function profilesCsv(profiles: readonly ProfileRecord[]): string {
  const header = CSV_FIELDS.join(',')
  const rows = profiles.map((profile) =>
    CSV_FIELDS.map((field) => escapeCsv(profile[field])).join(','),
  )
  return `\uFEFF${[header, ...rows].join('\r\n')}`
}
