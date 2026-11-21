import type {
  Account,
  AccountAddress,
  AccountAddressTarget,
  AccountList,
  AccountMailboxTarget,
  AccountStatus,
  AssignedMailbox,
  Binding,
  MailboxTarget,
} from './model.ts'
import { ACCOUNT_STATUSES, LOGIN_METHODS } from './model.ts'
import { parseObservation } from './observation.ts'

const invalid = (label = 'Vinted 账号池返回的数据格式无效，请刷新或更新插件后重试。') =>
  new Error(label)
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
function exact(row: Record<string, unknown>, keys: readonly string[]) {
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(row, key))
  )
    throw invalid()
}
export function string(value: unknown, max = 8192): string {
  if (typeof value !== 'string' || value.length > max) throw invalid()
  return value
}
export function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid()
  return value
}
export function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw invalid()
  return value
}
export function timestamp(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    value.length > 64
  )
    throw invalid()
  return value
}

export function parseMailbox(value: unknown): AssignedMailbox | null {
  if (value === null) return null
  const row = object(value)
  if (row.pluginId !== 'studio.email') throw invalid()
  exact(row, ['pluginId', 'mailboxId', 'email', 'linkedAt'])
  const mailboxId = string(row.mailboxId, 64)
  const email = string(row.email, 254)
  if (!mailboxId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid()
  return {
    pluginId: 'studio.email',
    mailboxId,
    email,
    linkedAt: timestamp(row.linkedAt)!,
  }
}

export function parseAddress(value: unknown): AccountAddress | null {
  if (value === null || value === undefined) return null
  const row = object(value)
  const countryCode = string(row.countryCode, 2)
  if (!/^[A-Z]{2}$/.test(countryCode) || !['osm', 'map'].includes(String(row.source)))
    throw invalid()
  for (const field of ['latitude', 'longitude'])
    if (typeof row[field] !== 'number' || !Number.isFinite(row[field])) throw invalid()
  return {
    id: string(row.id, 64),
    street: string(row.street, 200),
    houseNumber: string(row.houseNumber, 32),
    city: string(row.city, 120),
    postalCode: string(row.postalCode, 16),
    countryCode,
    state: row.state === null ? null : string(row.state, 120),
    county: row.county === null ? null : string(row.county, 120),
    latitude: row.latitude as number,
    longitude: row.longitude as number,
    source: row.source as 'osm' | 'map',
    sourceUrl: string(row.sourceUrl, 2048),
    approximate: bool(row.approximate),
    firstName: string(row.firstName, 80),
    lastName: string(row.lastName, 80),
    username: string(row.username, 20),
    linkedAt: timestamp(row.linkedAt)!,
  }
}

export function parseAccount(value: unknown): Account {
  const row = object(value)
  if (
    !LOGIN_METHODS.some((item) => item === row.loginMethod) ||
    !ACCOUNT_STATUSES.some((item) => item === row.status)
  )
    throw invalid()
  return {
    id: string(row.id, 64),
    loginMethod: row.loginMethod as Account['loginMethod'],
    account: string(row.account, 190),
    password: string(row.password, 190),
    phone: string(row.phone, 40),
    emailOtpUrl: string(row.emailOtpUrl, 2048),
    smsOtpUrl: string(row.smsOtpUrl, 2048),
    note: string(row.note, 200),
    status: row.status as AccountStatus,
    homepageUrl: string(row.homepageUrl, 2048),
    createdAt: timestamp(row.createdAt)!,
    updatedAt: timestamp(row.updatedAt)!,
    mailbox: parseMailbox(row.mailbox ?? null),
    address: parseAddress(row.address ?? null),
    ...(row.observation === undefined
      ? {}
      : { observation: parseObservation(row.observation) }),
  }
}

function parseBinding(value: unknown): Binding {
  const row = object(value)
  return {
    windowId: string(row.windowId, 64),
    accountId: string(row.accountId, 64),
    boundAt: timestamp(row.boundAt)!,
    ...(row.revision === undefined ? {} : { revision: string(row.revision, 128) }),
  }
}

export function parseAccountPage(value: unknown, expectedPage: number, pageSize: number) {
  const row = object(value)
  const items = Array.isArray(row.items)
    ? row.items.map(parseAccount)
    : (() => {
        throw invalid()
      })()
  const bindings = Array.isArray(row.bindings)
    ? row.bindings.map(parseBinding)
    : (() => {
        throw invalid()
      })()
  if (
    row.page !== expectedPage ||
    row.pageSize !== pageSize ||
    typeof row.revision !== 'string' ||
    !row.revision ||
    row.revision.length > 128 ||
    typeof row.storageDurable !== 'boolean'
  )
    throw invalid()
  const total = integer(row.total)
  if (
    total > 2000 ||
    items.length !==
      Math.max(0, Math.min(pageSize, total - (expectedPage - 1) * pageSize)) ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    throw invalid()
  const ids = new Set(items.map((item) => item.id))
  const windows = new Set<string>()
  for (const binding of bindings) {
    if (!ids.has(binding.accountId) || windows.has(binding.windowId))
      throw invalid('窗口关联数据无效，请刷新后重试。')
    windows.add(binding.windowId)
  }
  return {
    items,
    bindings,
    total,
    page: expectedPage,
    pageSize,
    revision: row.revision,
    storageDurable: row.storageDurable,
  }
}

export function parseAccountList(value: unknown): AccountList {
  const row = object(value)
  const items = Array.isArray(row.items)
    ? row.items.map(parseAccount)
    : (() => {
        throw invalid()
      })()
  const bindings = Array.isArray(row.bindings)
    ? row.bindings.map(parseBinding)
    : (() => {
        throw invalid()
      })()
  const total = integer(row.total)
  if (
    items.length !== total ||
    new Set(items.map((item) => item.id)).size !== items.length ||
    typeof row.storageDurable !== 'boolean'
  )
    throw invalid()
  const ids = new Set(items.map((item) => item.id))
  const windows = new Set<string>()
  for (const binding of bindings) {
    if (!ids.has(binding.accountId) || windows.has(binding.windowId))
      throw invalid('窗口关联数据无效，请刷新后重试。')
    windows.add(binding.windowId)
  }
  return { items, bindings, total, storageDurable: row.storageDurable }
}

export function parseMailboxTarget(value: unknown): MailboxTarget {
  const row = object(value)
  exact(row, ['id', 'email', 'enabled', 'status'])
  if (
    !['pending', 'active', 'reauth-required', 'error', 'paused'].includes(
      String(row.status),
    )
  )
    throw invalid()
  const email = string(row.email, 254)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid()
  return {
    id: string(row.id, 64),
    email,
    enabled: bool(row.enabled),
    status: row.status as MailboxTarget['status'],
  }
}

export function parseAccountMailboxTarget(value: unknown): AccountMailboxTarget {
  const row = object(value)
  exact(row, ['id', 'account', 'status', 'mailbox'])
  if (!ACCOUNT_STATUSES.some((item) => item === row.status)) throw invalid()
  return {
    id: string(row.id, 64),
    account: string(row.account, 190),
    status: row.status as AccountStatus,
    mailbox: parseMailbox(row.mailbox),
  }
}

export function parseAccountAddressTarget(value: unknown): AccountAddressTarget {
  const row = object(value)
  exact(row, ['id', 'account', 'status', 'address'])
  if (!ACCOUNT_STATUSES.some((item) => item === row.status)) throw invalid()
  return {
    id: string(row.id, 64),
    account: string(row.account, 190),
    status: row.status as AccountStatus,
    address: parseAddress(row.address),
  }
}

export { invalid as invalidAccountResponse }
