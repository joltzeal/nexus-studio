import {
  ACCOUNTS_CAPABILITY,
  ACCOUNTS_PLUGIN_ID,
  type Account,
  type AccountInput,
} from '@/features/accounts/types'
import { callPlugin } from '@/lib/platform/native-plugins'

/**
 * Linking a purchased number to a Vinted account.
 *
 * This composes the accounts plugin's existing list/save methods instead of
 * adding a narrow `setPhone` method to it: the page then works against every
 * version of that plugin already installed, and a future field on the account
 * record is carried through untouched.
 */
export interface AccountTarget {
  id: string
  account: string
  phone: string
  smsOtpUrl: string
  status: string
  note: string
}

interface AccountList {
  items: Account[]
}

function call<T>(method: string, payload: unknown = {}): Promise<T> {
  return callPlugin<T>(ACCOUNTS_PLUGIN_ID, ACCOUNTS_CAPABILITY, method, payload)
}

export async function listAccountTargets(): Promise<AccountTarget[]> {
  const result = await call<AccountList>('vinted.accounts.list')
  return result.items.map((account) => ({
    id: account.id,
    account: account.account,
    phone: account.phone,
    smsOtpUrl: account.smsOtpUrl,
    status: account.status,
    note: account.note,
  }))
}

/**
 * The save method replaces the whole record, so every field the account already
 * had has to travel back with it — including the ones this page does not touch.
 */
export function mergeAccountNumber(
  account: Account,
  phone: string,
  smsOtpUrl: string,
): AccountInput {
  return {
    id: account.id,
    loginMethod: account.loginMethod,
    account: account.account,
    password: account.password,
    phone,
    emailOtpUrl: account.emailOtpUrl,
    smsOtpUrl,
    note: account.note,
    status: account.status,
    homepageUrl: account.homepageUrl,
  }
}

/** Only the keys the caller passes change; the rest keeps its current value. */
export interface ContactPatch {
  phone?: string
  smsOtpUrl?: string
}

export async function updateContact(
  accountId: string,
  patch: ContactPatch,
): Promise<void> {
  const result = await call<AccountList>('vinted.accounts.list')
  const target = result.items.find((account) => account.id === accountId)
  if (target === undefined) throw new Error('账号不存在或已被删除')
  const phone = patch.phone ?? target.phone
  const smsOtpUrl = patch.smsOtpUrl ?? target.smsOtpUrl
  // An unchanged record still costs a full save round trip; skip it.
  if (phone === target.phone && smsOtpUrl === target.smsOtpUrl) return
  await call('vinted.accounts.save', mergeAccountNumber(target, phone, smsOtpUrl))
}

export function attachNumber(
  accountId: string,
  phone: string,
  smsOtpUrl: string,
): Promise<void> {
  return updateContact(accountId, { phone, smsOtpUrl })
}
