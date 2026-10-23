import { normalizeTel } from './normalize.js'
import type { PurchasedApi, SmsRead, SmsRecord } from './types.js'

/** One JSON document holds every number, so growth has to stay bounded. */
export const MAX_RECORDS = 2000

/**
 * A number is the identity: the provider reuses the same row when a card is
 * restarted or renewed, and a second purchase of the same number means the new
 * token supersedes the old one. Keying by anything else would leave two rows
 * whose record links disagree.
 *
 * The key drops the leading plus so `+1415…` and `1415…` are one number: the
 * same list arrives both ways depending on which endpoint answered.
 */
export function recordKey(tel: string): string {
  return normalizeTel(tel).replace(/^\+/, '')
}

function merge(existing: SmsRecord, incoming: PurchasedApi, now: string): SmsRecord {
  // A `url_list` line carries only the number and the link; blank fields must
  // not erase what a full row already told us.
  return {
    ...existing,
    token: incoming.token === '' ? existing.token : incoming.token,
    api: incoming.api === '' ? existing.api : incoming.api,
    apiId: incoming.apiId ?? existing.apiId,
    ordernum: incoming.ordernum === '' ? existing.ordernum : incoming.ordernum,
    appId: incoming.appId ?? existing.appId,
    cateId: incoming.cateId ?? existing.cateId,
    type: incoming.type ?? existing.type,
    endTime: incoming.endTime === '' ? existing.endTime : incoming.endTime,
    remark: incoming.remark === '' ? existing.remark : incoming.remark,
    status: incoming.status ?? existing.status,
    renew: incoming.renew ?? existing.renew,
    smsCount: incoming.smsCount ?? existing.smsCount,
    voiceCount: incoming.voiceCount ?? existing.voiceCount,
    updatedAt: now,
  }
}

/**
 * Folds a payload of numbers into the stored list. Existing rows keep their
 * `addedAt` and their last read, because the record link usually survives a
 * renewal while the code that was read from it does not change either.
 */
export function mergeRecords(
  existing: readonly SmsRecord[],
  incoming: readonly PurchasedApi[],
  now: string,
): SmsRecord[] {
  const byTel = new Map<string, SmsRecord>()
  for (const record of existing) byTel.set(recordKey(record.tel), record)

  for (const item of incoming) {
    const key = recordKey(item.tel)
    if (key === '') continue
    const current = byTel.get(key)
    if (current === undefined) {
      byTel.set(key, {
        ...item,
        // The key drops the plus for comparison; the row keeps it for display.
        tel: normalizeTel(item.tel),
        addedAt: now,
        updatedAt: now,
        lastRead: null,
      })
      continue
    }
    byTel.set(key, merge(current, item, now))
  }

  return [...byTel.values()]
    .sort((left, right) => right.addedAt.localeCompare(left.addedAt))
    .slice(0, MAX_RECORDS)
}

export function withLastRead(record: SmsRecord, read: SmsRead): SmsRecord {
  return { ...record, lastRead: read, updatedAt: read.fetchedAt }
}

export function findRecord(
  records: readonly SmsRecord[],
  tel: string,
): SmsRecord | undefined {
  const key = recordKey(tel)
  return records.find((record) => recordKey(record.tel) === key)
}

export function removeRecord(
  records: readonly SmsRecord[],
  tel: string,
): { records: SmsRecord[]; removed: boolean } {
  const key = recordKey(tel)
  const next = records.filter((record) => recordKey(record.tel) !== key)
  return { records: next, removed: next.length !== records.length }
}

/** The search box matches a number, its order number or its own remark. */
export function searchRecords(records: readonly SmsRecord[], query: string): SmsRecord[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...records]
  return records.filter((record) =>
    `${record.tel} ${record.ordernum} ${record.remark}`.toLowerCase().includes(needle),
  )
}
