export const ACCOUNTS_PLUGIN_ID = 'studio.vinted-accounts'
export const ACCOUNTS_CAPABILITY = 'account.pool'

export type LoginMethod = 'email' | 'google' | 'apple' | 'facebook'
export type AccountStatus = 'active' | 'pending' | 'limited' | 'blocked'

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
}

/** One window, one account; an account may appear on several windows. */
export interface Binding {
  windowId: string
  accountId: string
  boundAt: string
}

export interface BindingView extends Binding {
  account: {
    id: string
    account: string
    loginMethod: LoginMethod
    status: AccountStatus
    note: string
  } | null
}

export interface AccountList {
  items: Account[]
  total: number
  bindings: Binding[]
  storageDurable: boolean
}

export interface AccountInput {
  id?: string
  loginMethod: LoginMethod
  account: string
  password: string
  phone: string
  emailOtpUrl: string
  smsOtpUrl: string
  note: string
  status: AccountStatus
  homepageUrl: string
}

export interface ImportRowError {
  row: number
  message: string
}

export interface ImportReport {
  total: number
  inserted: number
  updated: number
  skipped: number
  errors: ImportRowError[]
}

export interface TemplateFile {
  filename: string
  mimeType: string
  base64: string
}

/**
 * One read of an account's inbox link. `code` is null when the body does not
 * carry exactly one four- or six-digit run, which is a normal answer — an empty
 * inbox, or a mailbox page that has not received the mail yet.
 */
export interface OtpResult {
  channel: 'email' | 'sms'
  code: string | null
  /** The response body, capped by the plugin; shown behind 查看原文. */
  body: string
  /** True when the plugin cut the body before sending it back. */
  truncated: boolean
  contentType: string
  fetchedAt: string
}

export const LOGIN_METHODS: readonly LoginMethod[] = [
  'email',
  'google',
  'apple',
  'facebook',
]

export const ACCOUNT_STATUSES: readonly AccountStatus[] = [
  'active',
  'pending',
  'limited',
  'blocked',
]

export const LOGIN_METHOD_LABELS: Record<LoginMethod, string> = {
  email: '邮箱',
  google: 'Google',
  apple: 'Apple',
  facebook: 'Facebook',
}

export const STATUS_LABELS: Record<AccountStatus, string> = {
  active: '正常',
  pending: '待验证',
  limited: '受限',
  blocked: '封禁',
}

export const EMPTY_ACCOUNT: Omit<AccountInput, 'id'> = {
  loginMethod: 'email',
  account: '',
  password: '',
  phone: '',
  emailOtpUrl: '',
  smsOtpUrl: '',
  note: '',
  status: 'active',
  homepageUrl: '',
}

export function message(error: unknown): string {
  return typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '请求失败，请稍后重试'
}

export function statusVariant(
  status: AccountStatus,
): 'secondary' | 'outline' | 'destructive' {
  if (status === 'blocked') return 'destructive'
  if (status === 'active') return 'secondary'
  return 'outline'
}

/** The table shows where an account is used, not which windows: ids are opaque. */
export function windowCountText(bindings: readonly Binding[], accountId: string): string {
  const count = bindings.filter((entry) => entry.accountId === accountId).length
  if (count === 0) return '未关联'
  return `${String(count)} 个窗口`
}
