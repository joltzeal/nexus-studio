import { callPlugin } from '@/lib/platform/native-plugins'
import { profileData, type Profile } from '@/features/addresses/types'
import type {
  OrderCandidate,
  OrderWatchSettings,
  OrderWatchView,
} from './order-watch-types'
import {
  ACCOUNTS_CAPABILITY,
  ACCOUNTS_PLUGIN_ID,
  ACCOUNT_STATUSES,
  LOGIN_METHODS,
  type Account,
  type AccountAddressSetResult,
  type AccountAddressTarget,
  type AccountAddressTargetList,
  type AccountAddressTargetsInput,
  type AccountInput,
  type AccountList,
  type AccountPage,
  type AssignedAccountAddress,
  type Binding,
  type BindingView,
  type ImportReport,
  type OtpResult,
  type TemplateFile,
} from './types'

function call<T>(method: string, payload: unknown = {}): Promise<T> {
  return callPlugin<T>(ACCOUNTS_PLUGIN_ID, ACCOUNTS_CAPABILITY, method, payload)
}

const ACCOUNT_PAGE_SIZE = 16
const ACCOUNT_LIST_UPDATE_HINT = '请更新 Vinted 账号池插件后读取分页账号列表。'

export async function listAccounts(): Promise<AccountList> {
  const readPage = async (page: number, revision?: string): Promise<AccountPage> => {
    const result = await call<unknown>('vinted.accounts.list', {
      page,
      pageSize: ACCOUNT_PAGE_SIZE,
      ...(revision === undefined ? {} : { revision }),
    })
    return accountPage(result, page)
  }
  const first = await readPage(1)
  const items: Account[] = []
  const bindings: Binding[] = []
  const ids = new Set<string>()
  const windows = new Set<string>()
  const pages = Math.max(1, Math.ceil(first.total / ACCOUNT_PAGE_SIZE))
  for (let page = 1; page <= pages; page += 1) {
    const current = page === 1 ? first : await readPage(page, first.revision)
    if (
      current.revision !== first.revision ||
      current.total !== first.total ||
      current.storageDurable !== first.storageDurable
    ) {
      throw new Error('账号列表已变化，请刷新后重试。')
    }
    const pageIds = new Set<string>()
    for (const account of current.items) {
      if (ids.has(account.id)) throw new Error('账号列表包含重复账号，请刷新后重试。')
      ids.add(account.id)
      pageIds.add(account.id)
    }
    for (const binding of current.bindings) {
      if (!pageIds.has(binding.accountId) || windows.has(binding.windowId)) {
        throw new Error('账号列表的窗口关联数据无效，请刷新后重试。')
      }
      windows.add(binding.windowId)
    }
    items.push(...current.items)
    bindings.push(...current.bindings)
  }
  return {
    items,
    bindings,
    total: first.total,
    storageDurable: first.storageDurable,
  }
}

export async function listAccountAddressTargets(
  input: AccountAddressTargetsInput = {},
): Promise<AccountAddressTargetList> {
  const result = await call<unknown>('vinted.accounts.address.targets', input)
  if (
    !record(result) ||
    !onlyKeys(result, ['items', 'total', 'page', 'pageSize', 'storageDurable']) ||
    !Array.isArray(result.items) ||
    !result.items.every(accountAddressTarget) ||
    !count(result.total) ||
    !count(result.page) ||
    result.page < 1 ||
    !count(result.pageSize) ||
    result.pageSize < 1 ||
    result.pageSize > 50 ||
    result.items.length > result.pageSize ||
    result.items.length > result.total ||
    typeof result.storageDurable !== 'boolean'
  ) {
    throw new Error('账号地址返回的数据格式无效，请刷新后重试。')
  }
  return result as unknown as AccountAddressTargetList
}

export async function assignAccountAddress(
  accountId: string,
  profile: Profile | null,
  expectedProfileId?: string | null,
): Promise<AccountAddressSetResult> {
  const result = await call<unknown>('vinted.accounts.address.set', {
    accountId,
    profile: profile === null ? null : profileData(profile),
    ...(expectedProfileId === undefined ? {} : { expectedProfileId }),
  })
  if (
    !record(result) ||
    !onlyKeys(result, ['address', 'updatedAt', 'storageDurable']) ||
    !(result.address === null || assignedAccountAddress(result.address)) ||
    (result.address?.id ?? null) !== (profile?.id ?? null) ||
    !isoTimestamp(result.updatedAt) ||
    typeof result.storageDurable !== 'boolean'
  ) {
    throw new Error('账号地址返回的数据格式无效，请刷新后重试。')
  }
  return result as unknown as AccountAddressSetResult
}

export function saveAccount(
  input: AccountInput,
): Promise<{ item: AccountList['items'][number]; created: boolean }> {
  return call('vinted.accounts.save', input)
}

export function removeAccount(accountId: string): Promise<{ removed: boolean }> {
  return call('vinted.accounts.remove', { accountId })
}

export function importAccounts(
  filename: string,
  content: { text: string } | { base64: string },
): Promise<ImportReport> {
  return call<ImportReport>('vinted.accounts.import', { filename, ...content })
}

export function downloadTemplate(format: 'csv' | 'xlsx'): Promise<TemplateFile> {
  return call<TemplateFile>('vinted.accounts.template', { format })
}

export function bindAccount(
  accountId: string,
  windowId: string,
  confirmDuplicates = false,
): Promise<{ bound: boolean; duplicates: string[] }> {
  return call('vinted.accounts.bind', { accountId, windowId, confirmDuplicates })
}

export function unbindWindow(windowId: string): Promise<{ unbound: boolean }> {
  return call('vinted.accounts.unbind', { windowId })
}

export function listBindings(): Promise<{ items: BindingView[] }> {
  return call<{ items: BindingView[] }>('vinted.accounts.bindings')
}

/** Reads the account's own inbox link; the plugin does the fetching. */
export function readOtp(accountId: string, channel: 'email' | 'sms'): Promise<OtpResult> {
  return call<OtpResult>('vinted.accounts.otp', { accountId, channel })
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function accountRecord(value: unknown): value is Account {
  return (
    record(value) &&
    boundedText(value.id, 64) &&
    LOGIN_METHODS.some((method) => method === value.loginMethod) &&
    ACCOUNT_STATUSES.some((status) => status === value.status) &&
    [
      'account',
      'password',
      'phone',
      'emailOtpUrl',
      'smsOtpUrl',
      'note',
      'homepageUrl',
      'createdAt',
      'updatedAt',
    ].every((key) => typeof value[key] === 'string') &&
    (value.address === undefined ||
      value.address === null ||
      assignedAccountAddress(value.address))
  )
}

function accountBinding(value: unknown): value is Binding {
  return (
    record(value) &&
    boundedText(value.accountId, 64) &&
    boundedText(value.windowId, 64) &&
    typeof value.boundAt === 'string'
  )
}

function accountPage(value: unknown, page: number): AccountPage {
  if (
    record(value) &&
    (value.page === undefined ||
      value.pageSize === undefined ||
      value.revision === undefined)
  ) {
    throw new Error(ACCOUNT_LIST_UPDATE_HINT)
  }
  if (
    !record(value) ||
    !onlyKeys(value, [
      'items',
      'bindings',
      'total',
      'storageDurable',
      'page',
      'pageSize',
      'revision',
    ]) ||
    value.page !== page ||
    value.pageSize !== ACCOUNT_PAGE_SIZE ||
    !boundedText(value.revision, 128) ||
    !count(value.total) ||
    value.total > 2000 ||
    typeof value.storageDurable !== 'boolean' ||
    !Array.isArray(value.items) ||
    value.items.length !==
      Math.min(
        ACCOUNT_PAGE_SIZE,
        Math.max(0, value.total - (page - 1) * ACCOUNT_PAGE_SIZE),
      ) ||
    !value.items.every(accountRecord) ||
    !Array.isArray(value.bindings) ||
    !value.bindings.every(accountBinding)
  ) {
    throw new Error('账号分页列表返回的数据格式无效，请刷新后重试。')
  }
  return value as unknown as AccountPage
}

function isoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function assignedAccountAddress(value: unknown): value is AssignedAccountAddress {
  return (
    record(value) &&
    onlyKeys(value, [
      'id',
      'street',
      'houseNumber',
      'city',
      'postalCode',
      'countryCode',
      'state',
      'county',
      'latitude',
      'longitude',
      'source',
      'sourceUrl',
      'approximate',
      'firstName',
      'lastName',
      'username',
      'linkedAt',
    ]) &&
    boundedText(value.id, 64) &&
    boundedText(value.street, 200) &&
    boundedText(value.houseNumber, 32) &&
    boundedText(value.city, 120) &&
    boundedText(value.postalCode, 16) &&
    typeof value.countryCode === 'string' &&
    /^[A-Z]{2}$/.test(value.countryCode) &&
    [value.state, value.county].every(
      (region) => region === null || (typeof region === 'string' && region.length <= 120),
    ) &&
    typeof value.latitude === 'number' &&
    Number.isFinite(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    typeof value.longitude === 'number' &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180 &&
    (value.source === 'osm' || value.source === 'map') &&
    typeof value.sourceUrl === 'string' &&
    value.sourceUrl.length <= 2048 &&
    typeof value.approximate === 'boolean' &&
    boundedText(value.firstName, 80) &&
    boundedText(value.lastName, 80) &&
    typeof value.username === 'string' &&
    /^[a-z][a-z0-9._-]{3,19}$/.test(value.username) &&
    isoTimestamp(value.linkedAt)
  )
}

function accountAddressTarget(value: unknown): value is AccountAddressTarget {
  return (
    record(value) &&
    onlyKeys(value, ['id', 'account', 'status', 'address']) &&
    boundedText(value.id, 64) &&
    boundedText(value.account, 190) &&
    ACCOUNT_STATUSES.some((status) => status === value.status) &&
    (value.address === null || assignedAccountAddress(value.address))
  )
}

function orderWatchSettings(value: unknown): value is OrderWatchSettings {
  return (
    record(value) &&
    typeof value.intervalMinutes === 'number' &&
    Number.isInteger(value.intervalMinutes) &&
    value.intervalMinutes >= 5 &&
    value.intervalMinutes <= 1440 &&
    record(value.bark) &&
    typeof value.bark.baseUrl === 'string' &&
    typeof value.bark.deviceKey === 'string' &&
    typeof value.bark.enabled === 'boolean'
  )
}

function orderCandidate(value: unknown): value is OrderCandidate {
  return (
    record(value) &&
    ['id', 'itemId', 'itemUrl', 'title', 'missingAt'].every(
      (key) => typeof value[key] === 'string',
    ) &&
    [
      'imageUrl',
      'lastSeenAt',
      'checkedAt',
      'checkError',
      'notifiedAt',
      'notifyError',
    ].every((key) => nullableString(value[key])) &&
    (value.status === 'pending' ||
      value.status === 'sold' ||
      value.status === 'reappeared')
  )
}

function orderWatchView(value: unknown): value is OrderWatchView {
  return (
    record(value) &&
    typeof value.accountId === 'string' &&
    typeof value.homepageUrl === 'string' &&
    typeof value.enabled === 'boolean' &&
    typeof value.running === 'boolean' &&
    nullableString(value.lastCompleteAt) &&
    (value.lastItemCount === null || count(value.lastItemCount)) &&
    nullableString(value.lastError) &&
    nullableString(value.nextRunAt) &&
    (value.pendingCount === undefined || count(value.pendingCount)) &&
    (value.soldCount === undefined || count(value.soldCount)) &&
    Array.isArray(value.candidates) &&
    value.candidates.every(orderCandidate)
  )
}

async function callOrderWatch<T>(
  method: string,
  payload: unknown,
  valid: (value: unknown) => value is T,
): Promise<T> {
  const result = await call<unknown>(method, payload)
  if (!valid(result)) throw new Error('订单查询返回的数据格式无效，请重试。')
  return result
}

export function getOrderWatchSettings(): Promise<OrderWatchSettings> {
  return callOrderWatch('vinted.accounts.orders.settings.get', {}, orderWatchSettings)
}

export function saveOrderWatchSettings(
  settings: OrderWatchSettings,
): Promise<OrderWatchSettings> {
  return callOrderWatch(
    'vinted.accounts.orders.settings.save',
    settings,
    orderWatchSettings,
  )
}

export function testOrderWatchBark(): Promise<{ sent: true }> {
  return callOrderWatch(
    'vinted.accounts.orders.bark.test',
    {},
    (value): value is { sent: true } => record(value) && value.sent === true,
  )
}

export function listOrderWatches(
  input: { accountId?: string } = {},
): Promise<{ items: OrderWatchView[] }> {
  return callOrderWatch(
    'vinted.accounts.orders.list',
    input,
    (value): value is { items: OrderWatchView[] } =>
      record(value) && Array.isArray(value.items) && value.items.every(orderWatchView),
  )
}

export function runOrderWatch(accountId: string): Promise<{ queued: boolean }> {
  return callOrderWatch(
    'vinted.accounts.orders.run',
    { accountId },
    (value): value is { queued: boolean } =>
      record(value) && typeof value.queued === 'boolean',
  )
}

export function setOrderWatchEnabled(
  accountId: string,
  enabled: boolean,
): Promise<{ enabled: boolean }> {
  return callOrderWatch(
    'vinted.accounts.orders.enabled',
    { accountId, enabled },
    (value): value is { enabled: boolean } =>
      record(value) && typeof value.enabled === 'boolean',
  )
}
