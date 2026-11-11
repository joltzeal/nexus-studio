import { callPlugin } from '@/lib/platform/native-plugins'
import type {
  OrderCandidate,
  OrderWatchSettings,
  OrderWatchView,
} from './order-watch-types'
import {
  ACCOUNTS_CAPABILITY,
  ACCOUNTS_PLUGIN_ID,
  type AccountInput,
  type AccountList,
  type BindingView,
  type ImportReport,
  type OtpResult,
  type TemplateFile,
} from './types'

function call<T>(method: string, payload: unknown = {}): Promise<T> {
  return callPlugin<T>(ACCOUNTS_PLUGIN_ID, ACCOUNTS_CAPABILITY, method, payload)
}

export function listAccounts(): Promise<AccountList> {
  return call<AccountList>('vinted.accounts.list')
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
