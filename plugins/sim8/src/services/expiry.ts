import { invalidRequest } from '../domain/errors.js'
import {
  EXPIRY_BATCH_SIZE,
  expiryCheckDue,
  expiryFromBody,
  expiryState,
  parseExpiry,
  reminderDay,
} from '../domain/expiry.js'
import { findRecord, recordKey } from '../domain/records.js'
import type { ExpirySnapshot, SmsRecord } from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { PrivateStore } from '../store/private-store.js'
import { readRecordLink } from './record-link.js'

export class ExpiryService {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly now: () => Date

  constructor(
    private readonly options: {
      store: PrivateStore
      now?: () => Date
      fetchImpl?: typeof fetch
    },
  ) {
    this.now = options.now ?? (() => new Date())
  }

  async list(): Promise<ExpirySnapshot> {
    const { records } = await this.options.store.read()
    const now = this.now()
    const items: ExpirySnapshot['items'] = []
    for (const record of records) {
      const at = parseExpiry(record.endTime)
      if (at === null) continue
      const day = reminderDay(at, now)
      if (day === null) continue
      const expiresAt = new Date(at).toISOString()
      if (record.expiry?.dismissedOn === day && record.expiry.dismissedFor === expiresAt)
        continue
      items.push({
        tel: record.tel,
        expiresAt,
        checkedAt: record.expiry?.checkedAt ?? null,
      })
    }
    items.sort(
      (a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.tel.localeCompare(b.tel),
    )
    return {
      items,
      pendingTels: records
        .filter((record) => expiryCheckDue(record, now))
        .sort((a, b) =>
          (a.expiry?.attemptedAt ?? '').localeCompare(b.expiry?.attemptedAt ?? ''),
        )
        .slice(0, EXPIRY_BATCH_SIZE)
        .map((record) => record.tel),
      failed: records.filter(
        (record) =>
          record.expiry?.attemptedAt &&
          record.expiry.attemptedAt !== record.expiry.checkedAt,
      ).length,
      storageDurable: this.options.store.durable,
    }
  }

  async dismiss(
    tel: string,
    expiresAt: string,
    context: DispatchContext,
  ): Promise<ExpirySnapshot> {
    await this.options.store.mutate((draft) => {
      context.assertAlive()
      const record = findRecord(draft.records, tel)
      if (!record) throw invalidRequest('号码已移除，请刷新后重试')
      const at = parseExpiry(record.endTime)
      if (at === null || new Date(at).toISOString() !== expiresAt)
        throw invalidRequest('号码到期时间已变化，请刷新后重试')
      const day = reminderDay(at, this.now())
      if (day !== null)
        record.expiry = {
          ...expiryState(record),
          dismissedOn: day,
          dismissedFor: expiresAt,
        }
    })
    return this.list()
  }

  async refresh(
    tels: readonly string[],
    context: DispatchContext,
  ): Promise<ExpirySnapshot> {
    // Serialize batches across callers; each batch has at most four active links.
    const run = () => this.checkBatch(tels, context)
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    await next
    context.assertAlive()
    return this.list()
  }

  private async checkBatch(
    tels: readonly string[],
    context: DispatchContext,
  ): Promise<void> {
    context.assertAlive()
    const wanted = new Set(tels.map(recordKey))
    const { records } = await this.options.store.read()
    const pending = records
      .filter(
        (record) =>
          wanted.has(recordKey(record.tel)) && expiryCheckDue(record, this.now()),
      )
      .slice(0, EXPIRY_BATCH_SIZE)
    const worker = async () => {
      for (let record = pending.shift(); record; record = pending.shift()) {
        await this.checkRecord(record, context)
      }
    }
    // Wait for all workers even after a storage/cancellation failure, before
    // allowing the next batch to start.
    const results = await Promise.allSettled(Array.from({ length: 4 }, worker))
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }

  private async checkRecord(
    snapshot: SmsRecord,
    context: DispatchContext,
  ): Promise<void> {
    const attemptedAt = this.now().toISOString()
    const matches = (record: SmsRecord) =>
      record.api === snapshot.api &&
      record.addedAt === snapshot.addedAt &&
      record.endTime === snapshot.endTime
    const started = await this.options.store.mutate((draft) => {
      context.assertAlive()
      const record = findRecord(draft.records, snapshot.tel)
      if (!record || !matches(record) || !expiryCheckDue(record, this.now())) return false
      record.expiry = { ...expiryState(record), attemptedAt }
      return true
    })
    if (!started) return
    let expiresAt: string | null = null
    try {
      const { body } = await readRecordLink(snapshot.api, this.options.fetchImpl)
      expiresAt = expiryFromBody(body)
    } catch {
      // Failure leaves the last known date intact and uses the retry backoff.
    }
    context.assertAlive()
    if (expiresAt === null) return
    await this.options.store.mutate((draft) => {
      context.assertAlive()
      const record = findRecord(draft.records, snapshot.tel)
      if (!record || !matches(record) || record.expiry?.attemptedAt !== attemptedAt)
        return
      record.endTime = expiresAt
      record.expiry = { ...expiryState(record), checkedAt: attemptedAt }
      record.updatedAt = this.now().toISOString()
    })
  }
}
