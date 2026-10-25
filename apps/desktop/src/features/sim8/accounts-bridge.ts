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
 * version of that plugin already installed. Keep mergeAccountNumber in sync
 * when the account's editable fields change.
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

/** Compare the supplied digits only; never infer a country code or drop zeroes. */
export function canonicalPhone(phone: string): string {
  return phone.replace(/\D/g, '')
}

export function indexAccountPhones(
  accounts: readonly AccountTarget[],
): Map<string, AccountTarget[]> {
  const index = new Map<string, AccountTarget[]>()
  for (const account of accounts) {
    const phone = canonicalPhone(account.phone)
    if (phone === '') continue
    const owners = index.get(phone)
    if (owners) owners.push(account)
    else index.set(phone, [account])
  }
  return index
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

const contactUpdates = new Map<string, Promise<Account>>()

export async function updateContact(
  accountId: string,
  patch: ContactPatch,
): Promise<Account> {
  // Several window rows can edit one account. Read after its earlier contact
  // write settles so an in-flight number assignment cannot undo a later unlink.
  const previous = contactUpdates.get(accountId)
  const next = previous
    ? previous.catch(() => undefined).then(() => writeContact(accountId, patch))
    : writeContact(accountId, patch)
  contactUpdates.set(accountId, next)
  try {
    return await next
  } finally {
    if (contactUpdates.get(accountId) === next) contactUpdates.delete(accountId)
  }
}

async function writeContact(accountId: string, patch: ContactPatch): Promise<Account> {
  const result = await call<AccountList>('vinted.accounts.list')
  const target = result.items.find((account) => account.id === accountId)
  if (target === undefined) throw new Error('账号不存在或已被删除')
  const phone = patch.phone ?? target.phone
  const smsOtpUrl = patch.smsOtpUrl ?? target.smsOtpUrl
  // An unchanged record still costs a full save round trip; skip it.
  if (phone === target.phone && smsOtpUrl === target.smsOtpUrl) return target
  const saved = await call<{ item: Account; created: boolean }>(
    'vinted.accounts.save',
    mergeAccountNumber(target, phone, smsOtpUrl),
  )
  return saved.item
}

export function attachNumber(
  accountId: string,
  phone: string,
  smsOtpUrl: string,
): Promise<Account> {
  return updateContact(accountId, { phone, smsOtpUrl })
}
