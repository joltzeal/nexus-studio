import { callPlugin } from '@/lib/platform/native-plugins'
import {
  ADDRESS_CAPABILITY,
  ADDRESS_PLUGIN_ID,
  profileData,
  type AddressCatalog,
  type AddressRecord,
  type GenerateResult,
  type MapsConfig,
  type Profile,
  type SavedAddressList,
  type SavedProfile,
} from './types'

function call<T>(method: string, payload: unknown = {}, deadlineMs?: number): Promise<T> {
  return callPlugin<T>(ADDRESS_PLUGIN_ID, ADDRESS_CAPABILITY, method, payload, deadlineMs)
}

/** Address lookups hit public mirrors; the host default of 30 s is too tight. */
const LOOKUP_DEADLINE = 60_000

export function getCatalog(): Promise<AddressCatalog> {
  return call<AddressCatalog>('address.catalog')
}

export function generateProfiles(
  country: string,
  cityId: string,
  count: number,
): Promise<GenerateResult> {
  return call<GenerateResult>(
    'address.generate',
    { country, cityId, count },
    LOOKUP_DEADLINE,
  )
}

/** Turns one map pick into a profile; the plugin owns the name and handle. */
export function profileFromPick(address: AddressRecord): Promise<{ item: Profile }> {
  return call<{ item: Profile }>('address.profile', { address })
}

export function csvOf(items: Profile[]): Promise<{ text: string; count: number }> {
  return call<{ text: string; count: number }>('address.csv', { items })
}

export function exportCsv(items: Profile[]): Promise<{ path: string; count: number }> {
  return call<{ path: string; count: number }>('address.export', { items })
}

export function getMapsConfig(): Promise<MapsConfig> {
  return call<MapsConfig>('address.config.get')
}

export function saveMapsKey(apiKey: string | null): Promise<MapsConfig> {
  return call<MapsConfig>('address.config.set', { apiKey })
}

export async function listSavedAddresses(
  input: { query?: string; page?: number; pageSize?: number } = {},
): Promise<SavedAddressList> {
  const result = await call<unknown>('address.saved.list', input)
  if (
    !record(result) ||
    !Array.isArray(result.items) ||
    !result.items.every(savedProfile) ||
    !integer(result.total, 0, 2000) ||
    !integer(result.page, 1, 10_000) ||
    !integer(result.pageSize, 1, 50) ||
    result.items.length > result.pageSize ||
    result.items.length > result.total ||
    typeof result.storageDurable !== 'boolean'
  ) {
    throw invalidResponse()
  }
  return result as unknown as SavedAddressList
}

export async function saveAddress(profile: Profile): Promise<{
  item: SavedProfile
  created: boolean
  storageDurable: boolean
}> {
  const result = await call<unknown>('address.saved.save', {
    profile: profileData(profile),
  })
  if (
    !record(result) ||
    !savedProfile(result.item) ||
    typeof result.created !== 'boolean' ||
    typeof result.storageDurable !== 'boolean'
  ) {
    throw invalidResponse()
  }
  return {
    item: result.item,
    created: result.created,
    storageDurable: result.storageDurable,
  }
}

export async function removeSavedAddress(id: string): Promise<{ removed: boolean }> {
  const result = await call<unknown>('address.saved.remove', { id })
  if (!record(result) || typeof result.removed !== 'boolean') throw invalidResponse()
  return { removed: result.removed }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integer(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  )
}

function text(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max
}

function savedProfile(value: unknown): value is SavedProfile {
  return (
    record(value) &&
    text(value.id, 1, 64) &&
    text(value.street, 1, 200) &&
    text(value.houseNumber, 1, 32) &&
    text(value.city, 1, 120) &&
    text(value.postalCode, 1, 16) &&
    typeof value.countryCode === 'string' &&
    /^[A-Z]{2}$/.test(value.countryCode) &&
    (value.state === null || text(value.state, 0, 120)) &&
    (value.county === null || text(value.county, 0, 120)) &&
    typeof value.latitude === 'number' &&
    Number.isFinite(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    typeof value.longitude === 'number' &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180 &&
    (value.source === 'osm' || value.source === 'map') &&
    text(value.sourceUrl, 0, 2048) &&
    typeof value.approximate === 'boolean' &&
    text(value.firstName, 1, 80) &&
    text(value.lastName, 1, 80) &&
    typeof value.username === 'string' &&
    /^[a-z][a-z0-9._-]{3,19}$/.test(value.username) &&
    typeof value.savedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value.savedAt) &&
    Number.isFinite(Date.parse(value.savedAt))
  )
}

function invalidResponse(): Error {
  return new Error('已保存地址返回的数据格式无效，请刷新后重试。')
}
