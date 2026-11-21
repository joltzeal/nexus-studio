import {
  ADDRESS_PLUGIN_ID,
  ADDRESS_CAPABILITY,
  addressKey,
  type Address,
  type Profile,
  type SavedProfile,
} from './model.ts'
import {
  bool,
  integer,
  invalid,
  object,
  parseAddress,
  parseCatalog,
  parseProfile,
  parseSaved,
  parseSavedPage,
  text,
} from './parse.ts'

type Rpc = <T>(
  id: string,
  capability: string,
  method: string,
  payload: unknown,
  parse: (value: unknown) => T,
) => Promise<T>
export function createAddressApi(call: Rpc) {
  const request = <T>(method: string, payload: unknown, parse: (value: unknown) => T) =>
    call(ADDRESS_PLUGIN_ID, ADDRESS_CAPABILITY, method, payload, parse)
  return {
    catalog: () => request('address.catalog', {}, parseCatalog),
    profile: (address: Address) => {
      const input = parseAddress(address)
      if (input.source !== 'map') throw new Error('请在地图上选择地址')
      return request('address.profile', { address: input }, (value) => {
        const profile = parseProfile(object(value).item)
        if (profile.source !== 'map' || addressKey(profile) !== addressKey(input))
          throw invalid()
        return profile
      })
    },
    list: (query = '', page = 1) =>
      request('address.saved.list', { query, page, pageSize: 20 }, (value) => {
        const result = parseSavedPage(value)
        if (
          result.pageSize !== 20 ||
          result.page !== Math.min(page, Math.max(1, Math.ceil(result.total / 20)))
        )
          throw invalid()
        return result
      }),
    save: (profile: Profile | SavedProfile) => {
      const input = parseProfile(profile)
      return request('address.saved.save', { profile: input }, (value) => {
        const row = object(value)
        const item = parseSaved(row.item)
        const created = bool(row.created)
        if (addressKey(item) !== addressKey(input) || (created && item.id !== input.id))
          throw invalid()
        return { item, created, storageDurable: bool(row.storageDurable) }
      })
    },
    remove: (id: string) =>
      request('address.saved.remove', { id }, (value) => ({
        removed: bool(object(value).removed),
      })),
    csv: (items: Profile[]) =>
      request('address.csv', { items: items.map(parseProfile) }, (value) => {
        const row = object(value)
        if (integer(row.count, 1, 50) !== items.length) throw invalid()
        return text(row.text, 256 * 1024, 1)
      }),
    export: (items: Profile[]) =>
      request('address.export', { items: items.map(parseProfile) }, (value) => {
        const row = object(value)
        if (integer(row.count, 1, 50) !== items.length) throw invalid()
        return text(row.path, 4096, 1)
      }),
  }
}
