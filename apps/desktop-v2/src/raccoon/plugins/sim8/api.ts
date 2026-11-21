import { SIM8_CAPABILITY, SIM8_PLUGIN_ID } from './methods.ts'
import {
  parseAllocation,
  parseApps,
  parseCategories,
  parseConfig,
  parseExpirySnapshot,
  parseFilterApps,
  parseFilterDetail,
  parseOrderApis,
  parseOrders,
  parsePrefixes,
  parsePurchase,
  parseRecordList,
  parseRenewReport,
  parseSmsRecord,
  parseSmsRead,
} from './parse.ts'
import type {
  AllocationState,
  ExpirySnapshot,
  FilterDetail,
  OrderApisResult,
  PurchaseResult,
  RecordList,
  RenewReport,
} from './types.ts'

type RpcCall = <T>(
  id: string,
  capability: string,
  method: string,
  payload: unknown,
  parse: (value: unknown) => T,
  deadlineMs?: number,
) => Promise<T>

const NETWORK_DEADLINE = 60_000
const emptyObject = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('SIM8 返回的数据格式无效，请刷新或更新插件后重试。')
  return value as Record<string, unknown>
}
const integer = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('SIM8 返回的数据格式无效，请刷新或更新插件后重试。')
  return value
}
const text = (value: unknown) => {
  if (typeof value !== 'string')
    throw new Error('SIM8 返回的数据格式无效，请刷新或更新插件后重试。')
  return value
}
const removed = (value: unknown) => integer(emptyObject(value).removed)

export function createSim8Api(rpc: RpcCall) {
  const call = <T>(
    method: string,
    payload: unknown,
    parse: (value: unknown) => T,
    deadlineMs?: number,
  ) => rpc(SIM8_PLUGIN_ID, SIM8_CAPABILITY, method, payload, parse, deadlineMs ?? 30_000)

  return {
    config: () => call('sim8.config.get', {}, parseConfig),
    saveConfig: (input: { token?: string | null; baseUrl?: string }) =>
      call('sim8.config.set', input, parseConfig, NETWORK_DEADLINE),
    profile: () =>
      call('sim8.profile', {}, (value) => {
        const row = emptyObject(value)
        const config = parseConfig({
          baseUrl: 'https://api.cc',
          hasToken: true,
          profile: row.profile,
          profileAt: row.profileAt,
          records: 0,
          storageDurable: true,
        })
        if (config.profile === null || config.profileAt === null)
          throw new Error('SIM8 返回的数据格式无效，请刷新或更新插件后重试。')
        return { profile: config.profile, profileAt: config.profileAt }
      }),
    categories: () => call('sim8.catalog.categories', {}, parseCategories),
    apps: (input: { cateId?: number; type?: number; name?: string }) =>
      call('sim8.catalog.apps', input, parseApps),
    prefixes: (input: { appId: number; type?: number; expiry?: number }) =>
      call('sim8.buy.prefixes', input, parsePrefixes),
    buy: (input: {
      appId: number
      num: number
      type?: number
      expiry?: number
      prefix?: string
      excludePrefix?: string
    }) => call<PurchaseResult>('sim8.buy.create', input, parsePurchase, NETWORK_DEADLINE),
    deferredBuy: (input: {
      appId: number
      num: number
      type?: number
      expiry?: number
      prefix?: string
      excludePrefix?: string
      requestId?: string
    }) =>
      call<AllocationState>(
        'sim8.buy.deferred',
        input,
        parseAllocation,
        NETWORK_DEADLINE,
      ),
    records: (query = '') =>
      call<RecordList>('sim8.records.list', { query }, parseRecordList),
    removeRecord: (tel: string) =>
      call('sim8.records.remove', { tel }, (value) => {
        const row = emptyObject(value)
        return { tel: text(row.tel), removed: row.removed === true }
      }),
    clearRecords: () => call('sim8.records.clear', {}, removed),
    readSms: (tel: string) =>
      call('sim8.sms.read', { tel }, (value) => {
        const row = emptyObject(value)
        return { tel: text(row.tel), result: parseSmsRead(row.result) }
      }),
    orders: (input: { page?: number; limit?: number; ordernum?: string }) =>
      call('sim8.orders.list', input, parseOrders),
    orderApis: (ordernum: string) =>
      call<OrderApisResult>('sim8.orders.apis', { ordernum }, parseOrderApis),
    orderOne: (ordernum: string) =>
      call('sim8.orders.one', { ordernum }, (value) => {
        const row = emptyObject(value)
        return { record: row.record === null ? null : parseSmsRecord(row.record) }
      }),
    changeToken: (apiId: number) =>
      call('sim8.orders.changeToken', { apiId }, (value) => {
        const row = emptyObject(value)
        return { record: row.record === null ? null : parseSmsRecord(row.record) }
      }),
    renewByTels: (tels: string[]) =>
      call<RenewReport>(
        'sim8.orders.renewText',
        { tels },
        parseRenewReport,
        NETWORK_DEADLINE,
      ),
    renewByIds: (ids: number[]) =>
      call(
        'sim8.orders.renewIds',
        { ids },
        (value) => ({ ids: text(emptyObject(value).ids) }),
        NETWORK_DEADLINE,
      ),
    filterApps: () => call('sim8.filter.apps', {}, parseFilterApps),
    createFilter: (input: { appId: number; code: string; numbers: string[] }) =>
      call(
        'sim8.filter.create',
        input,
        (value) => {
          const row = emptyObject(value)
          return { orderId: integer(row.orderId), count: integer(row.count) }
        },
        NETWORK_DEADLINE,
      ),
    filterDetail: (orderId: number) =>
      call<FilterDetail>('sim8.filter.detail', { orderId }, parseFilterDetail),
    expiryList: () => call<ExpirySnapshot>('sim8.expiry.list', {}, parseExpirySnapshot),
    expiryRefresh: (tels: string[]) =>
      call<ExpirySnapshot>(
        'sim8.expiry.refresh',
        { tels },
        parseExpirySnapshot,
        NETWORK_DEADLINE,
      ),
    expiryDismiss: (tel: string, expiresAt: string) =>
      call<ExpirySnapshot>(
        'sim8.expiry.dismiss',
        { tel, expiresAt },
        parseExpirySnapshot,
      ),
  }
}

const hostCall: RpcCall = (id, capability, method, payload, parse, deadlineMs) =>
  import('../call.ts').then(({ callPlugin }) =>
    callPlugin(id, capability, method, payload, parse, deadlineMs),
  )

export const sim8Api = createSim8Api(hostCall)
