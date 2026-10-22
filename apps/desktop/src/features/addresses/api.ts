import { callPlugin } from '@/lib/platform/native-plugins'
import {
  ADDRESS_CAPABILITY,
  ADDRESS_PLUGIN_ID,
  type AddressCatalog,
  type AddressRecord,
  type GenerateResult,
  type MapsConfig,
  type Profile,
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
