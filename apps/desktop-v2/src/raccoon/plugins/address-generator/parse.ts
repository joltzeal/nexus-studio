import type { Address, Catalog, Profile, SavedPage, SavedProfile } from './model.ts'

export const invalid = () => new Error('地址插件返回的数据无效，请刷新或更新插件后重试')
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
export function text(value: unknown, max = 200, min = 0): string {
  if (typeof value !== 'string' || value.length > max || value.trim().length < min)
    throw invalid()
  return value
}
export function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid()
  return value
}
export function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw invalid()
  return value
}
export function integer(value: unknown, min: number, max: number): number {
  const parsed = number(value, min, max)
  if (!Number.isSafeInteger(parsed)) throw invalid()
  return parsed
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalid()
  return value
}
function country(value: unknown) {
  const code = text(value, 2, 2)
  if (!/^[A-Z]{2}$/.test(code)) throw invalid()
  return code
}
function distinct(values: string[]) {
  if (new Set(values).size !== values.length) throw invalid()
}
export function parseCatalog(value: unknown): Catalog {
  const row = object(value)
  const countries = array(row.countries, 100).map((value) => {
    const item = object(value)
    return { code: country(item.code), label: text(item.label, 120, 1) }
  })
  distinct(countries.map((item) => item.code))
  const cities = array(row.cities, 5000).map((value) => {
    const item = object(value)
    const code = country(item.country)
    if (!countries.some((item) => item.code === code)) throw invalid()
    return {
      id: text(item.id, 64, 1),
      name: text(item.name, 120, 1),
      country: code,
      latitude: number(item.latitude, -90, 90),
      longitude: number(item.longitude, -180, 180),
    }
  })
  distinct(cities.map((item) => item.id))
  if (
    !countries.length ||
    !cities.length ||
    countries.some((country) => !cities.some((city) => city.country === country.code))
  )
    throw invalid()
  return { countries, cities }
}
export function parseAddress(value: unknown): Address {
  const row = object(value)
  if (row.source !== 'map' && row.source !== 'osm') throw invalid()
  const sourceUrl = text(row.sourceUrl, 2048)
  if (sourceUrl && new URL(sourceUrl).protocol !== 'https:') throw invalid()
  return {
    street: text(row.street, 200, 1),
    houseNumber: text(row.houseNumber, 32, 1),
    city: text(row.city, 120, 1),
    postalCode: text(row.postalCode, 16, 1),
    countryCode: country(row.countryCode),
    state: row.state === null ? null : text(row.state, 120),
    county: row.county === null ? null : text(row.county, 120),
    latitude: number(row.latitude, -90, 90),
    longitude: number(row.longitude, -180, 180),
    source: row.source,
    sourceUrl,
    approximate: bool(row.approximate),
  }
}
export function parseProfile(value: unknown): Profile {
  const row = object(value)
  const username = text(row.username, 20, 4)
  if (!/^[a-z][a-z0-9._-]*$/.test(username)) throw invalid()
  return {
    ...parseAddress(row),
    id: text(row.id, 64, 1),
    firstName: text(row.firstName, 80, 1),
    lastName: text(row.lastName, 80, 1),
    username,
  }
}
export function parseSaved(value: unknown): SavedProfile {
  const row = object(value)
  const savedAt = text(row.savedAt, 64, 1)
  if (!/^\d{4}-\d\d-\d\dT/.test(savedAt) || !Number.isFinite(Date.parse(savedAt)))
    throw invalid()
  return { ...parseProfile(row), savedAt }
}
export function parseSavedPage(value: unknown): SavedPage {
  const row = object(value)
  const total = integer(row.total, 0, 2000)
  const pageSize = integer(row.pageSize, 1, 50)
  const page = integer(row.page, 1, Math.max(1, Math.ceil(total / pageSize)))
  const items = array(row.items, pageSize).map(parseSaved)
  if (items.length !== Math.min(pageSize, total - (page - 1) * pageSize)) throw invalid()
  distinct(items.map((item) => item.id))
  return { items, total, page, pageSize, storageDurable: bool(row.storageDurable) }
}
