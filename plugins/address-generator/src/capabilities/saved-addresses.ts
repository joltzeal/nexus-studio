import { addressKey } from '../domain/address.js'
import { invalidRequest } from '../domain/errors.js'
import {
  SavedListInputSchema,
  SavedProfileInputSchema,
  SavedRemoveInputSchema,
  parseOrThrow,
} from '../domain/schemas.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { PrivateStore } from '../store/private-store.js'

export const SAVED_ADDRESS_METHODS = [
  'address.saved.list',
  'address.saved.save',
  'address.saved.remove',
] as const

export class SavedAddresses {
  constructor(
    private readonly store: PrivateStore,
    private readonly now: () => Date,
  ) {}

  async call(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    switch (context.method) {
      case 'address.saved.list': {
        const input = parseOrThrow(SavedListInputSchema, context.payload)
        const document = await this.store.read()
        context.assertAlive()
        const query = input.query.toLocaleLowerCase('en')
        const filtered = document.savedProfiles.filter((entry) =>
          [
            entry.firstName,
            entry.lastName,
            entry.username,
            entry.street,
            entry.houseNumber,
            entry.city,
            entry.postalCode,
            entry.state ?? '',
            entry.countryCode,
          ]
            .join(' ')
            .toLocaleLowerCase('en')
            .includes(query),
        )
        const page = Math.min(
          input.page,
          Math.max(1, Math.ceil(filtered.length / input.pageSize)),
        )
        return {
          items: filtered.slice((page - 1) * input.pageSize, page * input.pageSize),
          total: filtered.length,
          page,
          pageSize: input.pageSize,
          storageDurable: this.store.durable,
        }
      }
      case 'address.saved.save': {
        const { profile } = parseOrThrow(SavedProfileInputSchema, context.payload)
        return this.store.mutate((document) => {
          context.assertAlive()
          const sameId = document.savedProfiles.find((entry) => entry.id === profile.id)
          if (sameId && addressKey(sameId) !== addressKey(profile)) {
            throw invalidRequest('该地址标识已经保存了其他地址，请重新选择')
          }
          const existing =
            sameId ??
            document.savedProfiles.find(
              (entry) => addressKey(entry) === addressKey(profile),
            )
          if (existing)
            return { item: existing, created: false, storageDurable: this.store.durable }
          if (document.savedProfiles.length >= 2000) {
            throw invalidRequest('已保存地址达到 2000 条上限，请先移除部分地址')
          }
          const item = { ...profile, savedAt: this.now().toISOString() }
          document.savedProfiles.unshift(item)
          return { item, created: true, storageDurable: this.store.durable }
        })
      }
      case 'address.saved.remove': {
        const { id } = parseOrThrow(SavedRemoveInputSchema, context.payload)
        return this.store.mutate((document) => {
          context.assertAlive()
          const before = document.savedProfiles.length
          document.savedProfiles = document.savedProfiles.filter(
            (entry) => entry.id !== id,
          )
          return { removed: document.savedProfiles.length !== before }
        })
      }
      default:
        throw invalidRequest('插件不支持该方法')
    }
  }
}
