import type { AccountObservation } from './observation.ts'
export const ACCOUNT_PLUGIN_ID = 'studio.vinted-accounts'
export const ACCOUNT_CAPABILITY = 'account.pool'
export const EMAIL_PLUGIN_ID = 'studio.email'
export const EMAIL_CAPABILITY = 'email.provider'

export const ACCOUNT_METHOD_GROUPS = {
  base: [
    'vinted.accounts.list',
    'vinted.accounts.save',
    'vinted.accounts.remove',
    'vinted.accounts.import',
    'vinted.accounts.template',
    'vinted.accounts.otp',
    'vinted.accounts.bind',
    'vinted.accounts.unbind',
    'vinted.accounts.bindings',
  ],
  mailbox: ['vinted.accounts.mailbox.targets', 'vinted.accounts.mailbox.set'],
  mailboxImport: ['vinted.accounts.mailbox.import'],
  address: ['vinted.accounts.address.targets', 'vinted.accounts.address.set'],
  orderWatch: [
    'vinted.accounts.orders.settings.get',
    'vinted.accounts.orders.settings.save',
    'vinted.accounts.orders.bark.test',
    'vinted.accounts.orders.list',
    'vinted.accounts.orders.items',
    'vinted.accounts.orders.run',
    'vinted.accounts.orders.enabled',
  ],
} as const

export const LOGIN_METHODS = ['email', 'google', 'apple', 'facebook'] as const
export const ACCOUNT_STATUSES = [
  'unknown',
  'active',
  'pending',
  'limited',
  'blocked',
] as const
export type LoginMethod = (typeof LOGIN_METHODS)[number]
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]
export const DEFAULT_ACCOUNT_STATUS: AccountStatus = 'unknown'

export type AssignedMailbox = {
  pluginId: 'studio.email'
  mailboxId: string
  email: string
  linkedAt: string
}
export type AccountAddressTarget = {
  id: string
  account: string
  status: AccountStatus
  address: AccountAddress | null
}
export type AccountAddress = {
  id: string
  street: string
  houseNumber: string
  city: string
  postalCode: string
  countryCode: string
  state: string | null
  county: string | null
  latitude: number
  longitude: number
  source: 'osm' | 'map'
  sourceUrl: string
  approximate: boolean
  firstName: string
  lastName: string
  username: string
  linkedAt: string
}
export interface Account {
  id: string
  loginMethod: LoginMethod
  account: string
  password: string
  phone: string
  emailOtpUrl: string
  smsOtpUrl: string
  note: string
  status: AccountStatus
  homepageUrl: string
  createdAt: string
  updatedAt: string
  mailbox: AssignedMailbox | null
  address: AccountAddress | null
  observation?: AccountObservation
}
export interface Binding {
  windowId: string
  accountId: string
  boundAt: string
  revision?: string
}
export interface AccountList {
  items: Account[]
  bindings: Binding[]
  total: number
  storageDurable: boolean
}
export interface MailboxTarget {
  id: string
  email: string
  enabled: boolean
  status: string
}
export interface AccountMailboxTarget {
  id: string
  account: string
  status: AccountStatus
  mailbox: AssignedMailbox | null
}
export interface MailboxImportInput {
  mailboxes: { mailboxId: string; email: string }[]
  loginMethod: LoginMethod
  phone: string
  emailOtpUrl: string
  smsOtpUrl: string
  status: AccountStatus
  homepageUrl: string
  note: string
  expectedDuplicateIds: string[]
}

export const LOGIN_LABELS: Record<LoginMethod, string> = {
  email: '邮箱',
  google: 'Google',
  apple: 'Apple',
  facebook: 'Facebook',
}
export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  unknown: '未知',
  active: '正常',
  pending: '待验证',
  limited: '受限',
  blocked: '封禁',
}

export function supportsAccountMethods(
  methods: readonly string[],
  group: keyof typeof ACCOUNT_METHOD_GROUPS,
) {
  const available = new Set(methods)
  return ACCOUNT_METHOD_GROUPS[group].every((method) => available.has(method))
}
