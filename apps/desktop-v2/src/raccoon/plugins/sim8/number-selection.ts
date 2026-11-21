import type { Sim8AccountTarget } from './accounts.ts'
import { recordExpired, type SmsRecord } from './types.ts'

export const canonicalPhone = (phone: string) => phone.replace(/\D/g, '')

export async function loadNumberChoices(
  records: () => Promise<{ items: SmsRecord[] }>,
  accounts: () => Promise<Sim8AccountTarget[]>,
) {
  const [numbers, owners] = await Promise.allSettled([records(), accounts()])
  if (numbers.status === 'rejected') throw new Error('号码池读取失败，请重试')
  return {
    records: numbers.value.items,
    accounts: owners.status === 'fulfilled' ? owners.value : null,
  }
}

export function numberChoicePage(
  records: readonly SmsRecord[],
  accounts: readonly Sim8AccountTarget[] | null,
  currentAccountId: string | undefined,
  query: string,
  requestedPage: number,
  now = Date.now(),
) {
  const owners = new Map<string, Sim8AccountTarget[]>()
  for (const account of accounts ?? []) {
    const phone = canonicalPhone(account.phone)
    if (phone) owners.set(phone, [...(owners.get(phone) ?? []), account])
  }
  const needle = query.trim().toLowerCase()
  const digits = /^[+\d\s()-]+$/.test(needle) ? canonicalPhone(needle) : ''
  const filtered = records.filter(
    (record) =>
      !needle ||
      `${record.tel} ${record.remark} ${record.ordernum}`
        .toLowerCase()
        .includes(needle) ||
      (digits !== '' && canonicalPhone(record.tel).includes(digits)),
  )
  const pages = Math.max(1, Math.ceil(filtered.length / 20))
  const page = Math.max(1, Math.min(requestedPage, pages))
  return {
    page,
    pages,
    total: filtered.length,
    items: filtered.slice((page - 1) * 20, page * 20).map((record) => {
      const usage = owners.get(canonicalPhone(record.tel)) ?? []
      return {
        record,
        current: usage.some((owner) => owner.id === currentAccountId),
        others: usage.filter((owner) => owner.id !== currentAccountId),
        expired: recordExpired(record, now),
      }
    }),
  }
}
