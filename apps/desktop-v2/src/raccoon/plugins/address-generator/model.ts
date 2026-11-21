export const ADDRESS_PLUGIN_ID = 'studio.address-generator'
export const ADDRESS_CAPABILITY = 'address.generator'

export interface Address {
  street: string
  houseNumber: string
  city: string
  postalCode: string
  countryCode: string
  state: string | null
  county: string | null
  latitude: number
  longitude: number
  source: 'map' | 'osm'
  sourceUrl: string
  approximate: boolean
}
export interface Profile extends Address {
  id: string
  firstName: string
  lastName: string
  username: string
}
export interface SavedProfile extends Profile {
  savedAt: string
}
export interface City {
  id: string
  name: string
  country: string
  latitude: number
  longitude: number
}
export interface Catalog {
  countries: { code: string; label: string }[]
  cities: City[]
}
export interface SavedPage {
  items: SavedProfile[]
  total: number
  page: number
  pageSize: number
  storageDurable: boolean
}

export function addressText(address: Address): string {
  const street = `${address.houseNumber} ${address.street}`
  return address.countryCode === 'US'
    ? `${street}\n${address.city}${address.state ? `, ${address.state}` : ''} ${address.postalCode}\nUS`
    : `${street}\n${address.postalCode} ${address.city}\n${address.countryCode}`
}
export function addressKey(address: Address): string {
  return [
    address.countryCode,
    address.state ?? '',
    address.postalCode,
    address.city,
    `${address.houseNumber} ${address.street}`,
  ]
    .map((value) =>
      value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en'),
    )
    .join('|')
}

export function profileFields(
  profile: Profile,
): { id: keyof Profile; label: string; value: string }[] {
  return [
    { id: 'firstName', label: 'firstname', value: profile.firstName },
    { id: 'lastName', label: 'lastname', value: profile.lastName },
    { id: 'username', label: 'username', value: profile.username },
    { id: 'houseNumber', label: '门牌号', value: profile.houseNumber },
    { id: 'street', label: '街道', value: profile.street },
    { id: 'city', label: '城市', value: profile.city },
    { id: 'postalCode', label: '邮编', value: profile.postalCode },
    { id: 'state', label: '州 / 省', value: profile.state ?? '' },
    { id: 'county', label: '郡 / 县', value: profile.county ?? '' },
    { id: 'countryCode', label: '国家代码', value: profile.countryCode },
    { id: 'latitude', label: '纬度', value: String(profile.latitude) },
    { id: 'longitude', label: '经度', value: String(profile.longitude) },
    { id: 'source', label: '来源', value: profile.source },
    {
      id: 'approximate',
      label: '近似位置',
      value: profile.approximate ? 'true' : 'false',
    },
    { id: 'sourceUrl', label: '地图链接', value: profile.sourceUrl },
    { id: 'id', label: '资料标识', value: profile.id },
  ]
}
