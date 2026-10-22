/**
 * The catalog is the plugin's own allow-list: the page may only ask for a city
 * that exists here, so an arbitrary coordinate can never be turned into an
 * upstream Overpass query.
 */
export const COUNTRIES = [
  { code: 'US', label: '美国' },
  { code: 'FR', label: '法国' },
  { code: 'DE', label: '德国' },
  { code: 'GB', label: '英国' },
  { code: 'NL', label: '荷兰' },
  { code: 'BE', label: '比利时' },
  { code: 'ES', label: '西班牙' },
  { code: 'IT', label: '意大利' },
  { code: 'PL', label: '波兰' },
  { code: 'PT', label: '葡萄牙' },
] as const

export type CountryCode = (typeof COUNTRIES)[number]['code']

export const COUNTRY_CODES: readonly CountryCode[] = COUNTRIES.map(
  (country) => country.code,
)

export interface CityRecord {
  id: string
  name: string
  country: CountryCode
  latitude: number
  longitude: number
}

export const CITIES: readonly CityRecord[] = [
  {
    id: 'new-york',
    name: 'New York',
    country: 'US',
    latitude: 40.7128,
    longitude: -74.006,
  },
  {
    id: 'los-angeles',
    name: 'Los Angeles',
    country: 'US',
    latitude: 34.0522,
    longitude: -118.2437,
  },
  {
    id: 'chicago',
    name: 'Chicago',
    country: 'US',
    latitude: 41.8781,
    longitude: -87.6298,
  },
  { id: 'paris', name: 'Paris', country: 'FR', latitude: 48.8566, longitude: 2.3522 },
  { id: 'lyon', name: 'Lyon', country: 'FR', latitude: 45.764, longitude: 4.8357 },
  { id: 'lille', name: 'Lille', country: 'FR', latitude: 50.6292, longitude: 3.0573 },
  { id: 'berlin', name: 'Berlin', country: 'DE', latitude: 52.52, longitude: 13.405 },
  { id: 'hamburg', name: 'Hamburg', country: 'DE', latitude: 53.5511, longitude: 9.9937 },
  { id: 'munich', name: 'München', country: 'DE', latitude: 48.1351, longitude: 11.582 },
  { id: 'london', name: 'London', country: 'GB', latitude: 51.5074, longitude: -0.1278 },
  {
    id: 'manchester',
    name: 'Manchester',
    country: 'GB',
    latitude: 53.4808,
    longitude: -2.2426,
  },
  {
    id: 'edinburgh',
    name: 'Edinburgh',
    country: 'GB',
    latitude: 55.9533,
    longitude: -3.1883,
  },
  {
    id: 'amsterdam',
    name: 'Amsterdam',
    country: 'NL',
    latitude: 52.3676,
    longitude: 4.9041,
  },
  {
    id: 'rotterdam',
    name: 'Rotterdam',
    country: 'NL',
    latitude: 51.9244,
    longitude: 4.4777,
  },
  { id: 'utrecht', name: 'Utrecht', country: 'NL', latitude: 52.0907, longitude: 5.1214 },
  {
    id: 'brussels',
    name: 'Bruxelles',
    country: 'BE',
    latitude: 50.8503,
    longitude: 4.3517,
  },
  {
    id: 'antwerp',
    name: 'Antwerpen',
    country: 'BE',
    latitude: 51.2194,
    longitude: 4.4025,
  },
  { id: 'ghent', name: 'Gent', country: 'BE', latitude: 51.0543, longitude: 3.7174 },
  { id: 'madrid', name: 'Madrid', country: 'ES', latitude: 40.4168, longitude: -3.7038 },
  {
    id: 'barcelona',
    name: 'Barcelona',
    country: 'ES',
    latitude: 41.3874,
    longitude: 2.1686,
  },
  {
    id: 'valencia',
    name: 'València',
    country: 'ES',
    latitude: 39.4699,
    longitude: -0.3763,
  },
  { id: 'rome', name: 'Roma', country: 'IT', latitude: 41.9028, longitude: 12.4964 },
  { id: 'milan', name: 'Milano', country: 'IT', latitude: 45.4642, longitude: 9.19 },
  { id: 'turin', name: 'Torino', country: 'IT', latitude: 45.0703, longitude: 7.6869 },
  {
    id: 'warsaw',
    name: 'Warszawa',
    country: 'PL',
    latitude: 52.2297,
    longitude: 21.0122,
  },
  { id: 'krakow', name: 'Kraków', country: 'PL', latitude: 50.0647, longitude: 19.945 },
  { id: 'gdansk', name: 'Gdańsk', country: 'PL', latitude: 54.352, longitude: 18.6466 },
  { id: 'lisbon', name: 'Lisboa', country: 'PT', latitude: 38.7223, longitude: -9.1393 },
  { id: 'porto', name: 'Porto', country: 'PT', latitude: 41.1579, longitude: -8.6291 },
  { id: 'braga', name: 'Braga', country: 'PT', latitude: 41.5454, longitude: -8.4265 },
]

export function findCity(cityId: string): CityRecord | undefined {
  return CITIES.find((city) => city.id === cityId)
}

export function citiesOf(country: CountryCode): CityRecord[] {
  return CITIES.filter((city) => city.country === country)
}

export function isCountryCode(value: string): value is CountryCode {
  return COUNTRY_CODES.includes(value as CountryCode)
}
