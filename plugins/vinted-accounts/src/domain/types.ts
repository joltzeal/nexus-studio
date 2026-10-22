/** How the account signs in. Credentials are always present, even for OAuth. */
export type LoginMethod = 'email' | 'google' | 'apple' | 'facebook'

/** Where the account stands, as far as the operator knows. */
export type AccountStatus = 'active' | 'pending' | 'limited' | 'blocked'

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

/**
 * One credential record. `password` is stored in the plugin's private directory
 * only; it is never returned by a list call.
 */
export interface AccountRecord {
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

/**
 * A window holds at most one account, so `windowId` is the key. The same account
 * may appear on several windows: the page warns about it, the store allows it.
 */
export interface BindingRecord {
  windowId: string
  accountId: string
  boundAt: string
}

export interface ImportRowError {
  /** 1-based line in the source file, header included. */
  row: number
  message: string
}

export interface ImportReport {
  /** Rows that carried data, excluding the header. */
  total: number
  inserted: number
  updated: number
  skipped: number
  errors: ImportRowError[]
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

/** The template the page offers for download, already encoded for the browser. */
export interface TemplateFile {
  filename: string
  mimeType: string
  base64: string
}
