import { callPlugin } from '@/lib/platform/native-plugins'
import {
  SIM8_CAPABILITY,
  SIM8_PLUGIN_ID,
  type AllocationState,
  type AppItem,
  type CategoryItem,
  type FilterAppItem,
  type FilterDetail,
  type OrderApisResult,
  type OrderItem,
  type PrefixReport,
  type PurchaseResult,
  type RecordList,
  type RenewReport,
  type Sim8Config,
  type SmsReadResult,
  type SmsRecord,
} from './types'

function call<T>(method: string, payload: unknown = {}, deadlineMs?: number): Promise<T> {
  return callPlugin<T>(SIM8_PLUGIN_ID, SIM8_CAPABILITY, method, payload, deadlineMs)
}

/** The provider allocates on its side, so a purchase needs more than 30 s. */
const NETWORK_DEADLINE = 60_000

export function getConfig(): Promise<Sim8Config> {
  return call<Sim8Config>('sim8.config.get')
}

/** `token: null` clears it; omitting the field leaves it untouched. */
export function saveConfig(input: {
  token?: string | null
  baseUrl?: string
}): Promise<Sim8Config> {
  return call<Sim8Config>('sim8.config.set', input, NETWORK_DEADLINE)
}

export function fetchProfile(): Promise<{
  profile: Sim8Config['profile']
  profileAt: string
}> {
  return call('sim8.profile')
}

export function listCategories(): Promise<{ items: CategoryItem[]; total: number }> {
  return call('sim8.catalog.categories')
}

export function listApps(input: {
  cateId?: number
  type?: number
  name?: string
}): Promise<{ items: AppItem[]; total: number }> {
  return call('sim8.catalog.apps', input)
}

export function listPrefixes(input: {
  appId: number
  type?: number
  expiry?: number
}): Promise<PrefixReport> {
  return call<PrefixReport>('sim8.buy.prefixes', input)
}

export function buyNumbers(input: {
  appId: number
  num: number
  type?: number
  expiry?: number
  prefix?: string
  excludePrefix?: string
}): Promise<PurchaseResult> {
  return call<PurchaseResult>('sim8.buy.create', input, NETWORK_DEADLINE)
}

export function buyDeferred(input: {
  appId: number
  num: number
  type?: number
  expiry?: number
  prefix?: string
  excludePrefix?: string
}): Promise<AllocationState> {
  return call<AllocationState>('sim8.buy.deferred', input, NETWORK_DEADLINE)
}

export function listOrders(input: {
  page?: number
  limit?: number
  ordernum?: string
}): Promise<{ items: OrderItem[]; total: number }> {
  return call('sim8.orders.list', input)
}

export function listOrderApis(ordernum: string): Promise<OrderApisResult> {
  return call<OrderApisResult>('sim8.orders.apis', { ordernum })
}

export function fetchOrderApi(ordernum: string): Promise<{ record: SmsRecord | null }> {
  return call('sim8.orders.one', { ordernum })
}

export function changeToken(apiId: number): Promise<{ record: SmsRecord | null }> {
  return call('sim8.orders.changeToken', { apiId })
}

export function renewByTels(tels: string[]): Promise<RenewReport> {
  return call<RenewReport>('sim8.orders.renewText', { tels }, NETWORK_DEADLINE)
}

export function renewByIds(ids: number[]): Promise<{ ids: string }> {
  return call('sim8.orders.renewIds', { ids }, NETWORK_DEADLINE)
}

export function listFilterApps(): Promise<{ items: FilterAppItem[]; total: number }> {
  return call('sim8.filter.apps')
}

export function createFilterOrder(input: {
  appId: number
  code: string
  numbers: string[]
}): Promise<{ orderId: number; count: number }> {
  return call('sim8.filter.create', input, NETWORK_DEADLINE)
}

export function filterDetail(orderId: number): Promise<FilterDetail> {
  return call<FilterDetail>('sim8.filter.detail', { orderId })
}

export function listRecords(query = ''): Promise<RecordList> {
  return call<RecordList>('sim8.records.list', { query })
}

export function removeRecord(tel: string): Promise<{ tel: string; removed: boolean }> {
  return call('sim8.records.remove', { tel })
}

export function clearRecords(): Promise<{ removed: number }> {
  return call('sim8.records.clear')
}

export function readSms(tel: string): Promise<SmsReadResult> {
  return call<SmsReadResult>('sim8.sms.read', { tel })
}
