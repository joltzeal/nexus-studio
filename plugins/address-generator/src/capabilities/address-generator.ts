import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { profilesCsv, type AddressRecord, type ProfileRecord } from '../domain/address.js'
import {
  invalidRequest,
  notConfigured,
  unavailable,
  upstreamFailure,
  UpstreamError,
} from '../domain/errors.js'
import {
  ConfigureInputSchema,
  GenerateInputSchema,
  ItemsInputSchema,
  ProfileInputSchema,
  parseOrThrow,
} from '../domain/schemas.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import { CITIES, COUNTRIES, findCity, type CountryCode } from '../services/catalog.js'
import { PublicAddressService, sampleAddresses } from '../services/overpass.js'
import { buildProfiles } from '../services/profiles.js'
import type { PrivateStore } from '../store/private-store.js'
import type { SecretVault } from '../store/secret-vault.js'

export const ADDRESS_METHODS = [
  'address.catalog',
  'address.generate',
  'address.profile',
  'address.csv',
  'address.export',
  'address.config.get',
  'address.config.set',
] as const

export const MAPS_KEY_SLOT = 'google-maps-key'

export interface AddressGeneratorOptions {
  store: PrivateStore
  vault: SecretVault
  lookup: PublicAddressService
  logger: Logger
  now?: () => Date
  random?: () => number
  idFactory?: () => string
}

interface MapsKeyState {
  hasApiKey: boolean
  /** The browser key the page loads the Maps SDK with; null when unset. */
  apiKey: string | null
  storageDurable: boolean
}

/**
 * `address.generator` capability. Every method is a query except the map key,
 * which is the only thing this plugin stores.
 */
export class AddressGenerator {
  readonly id = 'address.generator'
  readonly name = '地址生成器'

  private readonly store: PrivateStore
  private readonly vault: SecretVault
  private readonly lookup: PublicAddressService
  private readonly logger: Logger
  private readonly now: () => Date
  private readonly random: () => number
  private readonly idFactory: () => string

  constructor(options: AddressGeneratorOptions) {
    this.store = options.store
    this.vault = options.vault
    this.lookup = options.lookup
    this.logger = options.logger
    this.now = options.now ?? (() => new Date())
    this.random = options.random ?? Math.random
    this.idFactory = options.idFactory ?? randomUUID
  }

  status(): Record<string, unknown> {
    return { storage: this.store.kind, storageDurable: this.store.durable }
  }

  async call(context: DispatchContext): Promise<unknown> {
    switch (context.method) {
      case 'address.catalog':
        context.assertAlive()
        return {
          countries: COUNTRIES.map((country) => ({ ...country })),
          cities: CITIES.map((city) => ({ ...city })),
        }
      case 'address.generate':
        return await this.generate(context)
      case 'address.profile':
        return this.profile(context)
      case 'address.csv':
        return this.csv(context)
      case 'address.export':
        return await this.exportCsv(context)
      case 'address.config.get':
        return await this.readConfig(context)
      case 'address.config.set':
        return await this.writeConfig(context)
      default:
        throw invalidRequest('插件不支持该方法')
    }
  }

  private async generate(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(GenerateInputSchema, context.payload)
    const city = findCity(input.cityId)
    if (city === undefined || city.country !== input.country) {
      throw invalidRequest('所选城市不属于该国家')
    }
    let result
    try {
      result = await this.lookup.list(city)
    } catch (error) {
      if (error instanceof UpstreamError) {
        this.logger.warn('公开地址查询失败', {
          city: city.id,
          reason: error.reason,
          attempts: error.attempts.length,
        })
        throw upstreamFailure(error)
      }
      throw error
    }
    context.assertAlive()
    const sampled = sampleAddresses(result.items, input.count, this.random)
    const items = buildProfiles(sampled, {
      country: input.country,
      random: this.random,
      idFactory: this.idFactory,
    })
    return {
      items,
      requested: input.count,
      found: items.length,
      poolSize: result.items.length,
      endpoint: result.endpoint,
      cached: result.cached,
    }
  }

  private profile(context: DispatchContext): unknown {
    context.assertAlive()
    const input = parseOrThrow(ProfileInputSchema, context.payload)
    const address: AddressRecord = { ...input.address }
    const [profile] = buildProfiles([address], {
      country: address.countryCode as CountryCode,
      random: this.random,
      idFactory: this.idFactory,
    })
    if (profile === undefined) throw unavailable('生成资料失败')
    return { item: profile }
  }

  private csv(context: DispatchContext): unknown {
    context.assertAlive()
    const input = parseOrThrow(ItemsInputSchema, context.payload)
    const text = profilesCsv(input.items as ProfileRecord[])
    return { text, count: input.items.length }
  }

  private async exportCsv(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    const input = parseOrThrow(ItemsInputSchema, context.payload)
    const directory = this.store.exportDirectory
    if (directory === null) {
      throw notConfigured('宿主未提供插件私有目录，无法写入 CSV 文件')
    }
    const stamp = this.now().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
    const file = join(directory, `addresses-${stamp}.csv`)
    const text = profilesCsv(input.items as ProfileRecord[])
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(file, text, { mode: 0o600 })
    } catch (error) {
      throw unavailable('CSV 写入失败，文件没有保存', error)
    }
    context.assertAlive()
    return { path: file, count: input.items.length }
  }

  private async readConfig(context: DispatchContext): Promise<MapsKeyState> {
    context.assertAlive()
    const document = await this.store.read()
    const ref = document.maps.apiKeyRef
    if (ref === null) {
      return { hasApiKey: false, apiKey: null, storageDurable: this.store.durable }
    }
    try {
      const apiKey = await this.vault.resolve(ref)
      return { hasApiKey: true, apiKey, storageDurable: this.store.durable }
    } catch {
      // The reference outlived its value. Report it as unset instead of failing
      // the whole settings read; saving a new key replaces the reference.
      return { hasApiKey: false, apiKey: null, storageDurable: this.store.durable }
    }
  }

  private async writeConfig(context: DispatchContext): Promise<MapsKeyState> {
    context.assertAlive()
    const input = parseOrThrow(ConfigureInputSchema, context.payload)
    if (input.apiKey === undefined) return await this.readConfig(context)

    const raw = input.apiKey === null ? '' : input.apiKey.trim()
    if (raw !== '' && (raw.length < 10 || /\s/.test(raw))) {
      throw invalidRequest('地图 Key 需要是不含空白的字符串')
    }
    const previous = (await this.store.read()).maps.apiKeyRef
    if (raw === '') {
      await this.store.mutate((document) => {
        document.maps.apiKeyRef = null
      })
      if (previous !== null) await this.vault.drop(previous)
      return { hasApiKey: false, apiKey: null, storageDurable: this.store.durable }
    }
    const { ref } = await this.vault.put(MAPS_KEY_SLOT, raw)
    await this.store.mutate((document) => {
      document.maps.apiKeyRef = ref
    })
    if (previous !== null) await this.vault.drop(previous)
    this.logger.info('地图 Key 已保存到插件私有目录')
    return { hasApiKey: true, apiKey: raw, storageDurable: this.store.durable }
  }
}
