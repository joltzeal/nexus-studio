import { mergeAccountNumber, type ContactPatch } from '@/features/sim8/accounts-bridge'
import { listAccounts, saveAccount } from './api'
import type { Account } from './types'

export type ContactSnapshot = Pick<Account, 'id' | 'phone' | 'smsOtpUrl'>

export class ContactChangedError extends Error {
  constructor() {
    super('账号联系方式已变化，请取消并刷新资料后重新确认。')
  }
}

export function sameContact(current: ContactSnapshot, expected: ContactSnapshot) {
  return (
    current.id === expected.id &&
    current.phone === expected.phone &&
    current.smsOtpUrl === expected.smsOtpUrl
  )
}

export async function updateConfirmedContact(
  expected: ContactSnapshot,
  patch: ContactPatch,
  assertCurrent: () => void,
): Promise<Account> {
  assertCurrent()
  const { items } = await listAccounts()
  assertCurrent()
  const current = items.find((item) => item.id === expected.id)
  if (!current || !sameContact(current, expected)) throw new ContactChangedError()
  const phone = patch.phone ?? current.phone
  const smsOtpUrl = patch.smsOtpUrl ?? current.smsOtpUrl
  if (phone === current.phone && smsOtpUrl === current.smsOtpUrl) return current
  // Preserve unrelated latest fields; expectedUpdatedAt rejects a write after this read.
  const { item } = await saveAccount(mergeAccountNumber(current, phone, smsOtpUrl))
  return item
}
