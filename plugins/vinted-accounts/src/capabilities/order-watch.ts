import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  CONFIGURATION_METHODS,
  createConfigurationTransfer,
} from '@nexus/plugin-sdk/configuration'
import { z } from 'zod'

import {
  PluginFailure,
  cancelled,
  invalidRequest,
  isPluginFailure,
} from '../domain/errors.js'
import {
  OrderWatchSettingsSchema,
  reconcileOrderRecords,
  type OrderWatchRecord,
  type OrderWatchSettings,
} from '../domain/order-watch.js'
import { parseOrThrow } from '../domain/schemas.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import { sendBark } from '../services/bark.js'
import {
  VintedOrderSource,
  parseHomepage,
  type OrderSource,
  type SnapshotItem,
} from '../services/order-source.js'
import type { AccountStore, StoreDocument } from '../store/account-store.js'

export const ORDER_WATCH_METHODS = [
  'vinted.accounts.orders.settings.get',
  'vinted.accounts.orders.settings.save',
  'vinted.accounts.orders.bark.test',
  'vinted.accounts.orders.list',
  'vinted.accounts.orders.run',
  'vinted.accounts.orders.enabled',
  ...CONFIGURATION_METHODS,
] as const

const emptyInput = z.strictObject({})
const accountIdInput = z.strictObject({ accountId: z.string().trim().min(1).max(64) })
const enabledInput = accountIdInput.extend({ enabled: z.boolean() })
const listInput = accountIdInput.partial()
const MAX_CONCURRENT = 2
const MAX_CHECKS = 20
const MAX_HISTORY = 100
const MAX_CANDIDATES = 4000
const TICK_MS = 15_000
const RUN_TIMEOUT_MS = 15 * 60_000

class CandidateLimitError extends PluginFailure {
  constructor() {
    super('UNAVAILABLE', '待核查商品过多，本轮保留上次完整快照')
  }
}

interface ActiveRun {
  accountId: string
  revision: string
  homepageUrl: string
  controller: AbortController
  job: Promise<void>
}

export interface AccountOrderWatchOptions {
  store: AccountStore
  logger: Logger
  now?: () => Date
  fetchImpl?: typeof fetch
  sourceFactory?: () => OrderSource
  checkDelayMs?: number
}

/** Plugin-owned scheduling continues while the account page is closed. */
export class AccountOrderWatch {
  private readonly store: AccountStore
  private readonly logger: Logger
  private readonly now: () => Date
  private readonly fetchImpl: typeof fetch | undefined
  private readonly sourceFactory: () => OrderSource
  private readonly checkDelayMs: number
  private readonly active = new Map<string, ActiveRun>()
  private readonly testPushes = new Map<AbortController, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private ticking = false

  constructor(options: AccountOrderWatchOptions) {
    this.store = options.store
    this.logger = options.logger
    this.now = options.now ?? (() => new Date())
    this.fetchImpl = options.fetchImpl
    this.sourceFactory =
      options.sourceFactory ??
      (() =>
        new VintedOrderSource(
          options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
        ))
    this.checkDelayMs = options.checkDelayMs ?? 1000
  }

  start(): void {
    if (this.stopped || this.timer) return
    const poll = () => {
      void this.tick().catch(() => {
        this.logger.warn('订单查询调度失败，请检查插件存储后重试')
      })
    }
    this.timer = setInterval(poll, TICK_MS)
    this.timer.unref()
    poll()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const run of this.active.values()) run.controller.abort()
    for (const controller of this.testPushes.keys()) controller.abort()
    await Promise.allSettled([
      ...[...this.active.values()].map((run) => run.job),
      ...this.testPushes.values(),
    ])
  }

  async call(context: DispatchContext): Promise<unknown> {
    context.assertAlive()
    switch (context.method) {
      case 'configuration.export':
      case 'configuration.validate':
      case 'configuration.import':
        return createConfigurationTransfer({
          schema: OrderWatchSettingsSchema,
          read: async () => (await this.store.read()).orderWatch.settings,
          apply: (value) => this.saveSettings(value, context.assertAlive),
          invalid: invalidRequest,
        }).call(context)
      case 'vinted.accounts.orders.settings.get':
        parseOrThrow(emptyInput, context.payload)
        return (await this.store.read()).orderWatch.settings
      case 'vinted.accounts.orders.settings.save': {
        const settings = parseOrThrow(OrderWatchSettingsSchema, context.payload)
        await this.saveSettings(settings, context.assertAlive)
        return settings
      }
      case 'vinted.accounts.orders.bark.test': {
        parseOrThrow(emptyInput, context.payload)
        const settings = (await this.store.read()).orderWatch.settings
        context.assertAlive()
        if (this.stopped) throw cancelled('插件已停止')
        const controller = new AbortController()
        const signal = AbortSignal.any([
          controller.signal,
          ...(context.signal ? [context.signal] : []),
        ])
        const push = sendBark(
          settings.bark,
          { title: 'Nexus 测试通知', body: 'Vinted 订单提醒已连接' },
          { ...this.fetchOptions(), signal },
        )
        this.testPushes.set(controller, push)
        try {
          await push
        } finally {
          this.testPushes.delete(controller)
        }
        context.assertAlive()
        return { sent: true }
      }
      case 'vinted.accounts.orders.list': {
        const input = parseOrThrow(listInput, context.payload)
        return this.list(input.accountId)
      }
      case 'vinted.accounts.orders.run': {
        const input = parseOrThrow(accountIdInput, context.payload)
        const document = await this.reconcile()
        context.assertAlive()
        const record = document.orderWatch.records.find(
          (entry) => entry.accountId === input.accountId,
        )
        if (!record) throw invalidRequest('请为账号填写有效的 Vinted 用户主页')
        if (!record.enabled) throw invalidRequest('请先恢复此账号的订单查询')
        return { queued: this.launch(record) !== null }
      }
      case 'vinted.accounts.orders.enabled': {
        const input = parseOrThrow(enabledInput, context.payload)
        await this.reconcile()
        await this.store.mutate((document) => {
          context.assertAlive()
          const record = document.orderWatch.records.find(
            (entry) => entry.accountId === input.accountId,
          )
          if (!record) throw invalidRequest('请为账号填写有效的 Vinted 用户主页')
          if (record.enabled !== input.enabled) record.revision = randomUUID()
          record.enabled = input.enabled
          if (input.enabled) record.nextRunAt = null
        })
        if (!input.enabled) this.active.get(input.accountId)?.controller.abort()
        return { enabled: input.enabled }
      }
      default:
        throw invalidRequest('插件不支持该方法')
    }
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      const document = await this.reconcile()
      if (this.stopped) return
      const now = this.now().getTime()
      const due = document.orderWatch.records
        .filter(
          (record) =>
            record.enabled &&
            (record.nextRunAt === null || Date.parse(record.nextRunAt) <= now),
        )
        .sort(
          (a, b) =>
            (a.nextRunAt === null ? 0 : Date.parse(a.nextRunAt)) -
            (b.nextRunAt === null ? 0 : Date.parse(b.nextRunAt)),
        )
      const jobs: Promise<void>[] = []
      for (const record of due) {
        const job = this.launch(record)
        if (job) jobs.push(job)
        if (this.active.size >= MAX_CONCURRENT) break
      }
      await Promise.all(jobs)
    } finally {
      this.ticking = false
    }
  }

  private async reconcile(): Promise<StoreDocument> {
    let document = await this.store.read()
    const records = reconcileOrderRecords(document.accounts, document.orderWatch.records)
    if (
      records.length !== document.orderWatch.records.length ||
      records.some((record, index) => record !== document.orderWatch.records[index])
    ) {
      await this.store.mutate(() => undefined)
      document = await this.store.read()
    }
    for (const run of this.active.values()) {
      if (
        !document.orderWatch.records.some(
          (entry) =>
            entry.accountId === run.accountId &&
            entry.revision === run.revision &&
            entry.enabled,
        )
      ) {
        run.controller.abort()
      }
    }
    return document
  }

  private async saveSettings(
    settings: OrderWatchSettings,
    assertAlive: () => void = () => undefined,
  ): Promise<void> {
    await this.store.mutate((document) => {
      assertAlive()
      document.orderWatch.settings = settings
      // Re-evaluate schedules after a settings import or interval change.
      for (const record of document.orderWatch.records) {
        record.nextRunAt =
          record.lastCompleteAt === null
            ? null
            : new Date(
                Date.parse(record.lastCompleteAt) + settings.intervalMinutes * 60_000,
              ).toISOString()
      }
    })
  }

  private async list(accountId?: string): Promise<unknown> {
    const document = await this.reconcile()
    const records = new Map(
      document.orderWatch.records.map((record) => [record.accountId, record]),
    )
    const items = document.accounts
      .filter(
        (account) =>
          account.homepageUrl.trim() &&
          (accountId === undefined || account.id === accountId),
      )
      .map((account) => {
        const record = records.get(account.id)
        const run = this.active.get(account.id)
        return {
          accountId: account.id,
          homepageUrl:
            record?.homepageUrl ??
            (accountId === undefined ? '' : account.homepageUrl.slice(0, 2048)),
          enabled: record?.enabled ?? false,
          running: run?.revision === record?.revision && run !== undefined,
          lastCompleteAt: record?.lastCompleteAt ?? null,
          lastItemCount: record?.snapshot?.length ?? null,
          lastError: record
            ? record.lastError && accountId === undefined
              ? '查询失败，请查看详情'
              : record.lastError
            : '请填写有效的 Vinted 用户主页',
          nextRunAt: record?.nextRunAt ?? null,
          pendingCount:
            record?.candidates.filter((item) => item.status === 'pending').length ?? 0,
          soldCount:
            record?.candidates.filter((item) => item.status === 'sold').length ?? 0,
          candidates:
            accountId === undefined
              ? []
              : (record?.candidates.slice(-100).reverse() ?? []),
        }
      })
    return { items }
  }

  private launch(record: OrderWatchRecord): Promise<void> | null {
    if (
      this.stopped ||
      this.active.has(record.accountId) ||
      this.active.size >= MAX_CONCURRENT
    ) {
      return null
    }
    const run: ActiveRun = {
      accountId: record.accountId,
      revision: record.revision,
      homepageUrl: record.homepageUrl,
      controller: new AbortController(),
      job: Promise.resolve(),
    }
    this.active.set(record.accountId, run)
    run.job = this.execute(run).finally(() => {
      if (this.active.get(run.accountId) === run) this.active.delete(run.accountId)
    })
    return run.job
  }

  private current(document: StoreDocument, run: ActiveRun): OrderWatchRecord {
    run.controller.signal.throwIfAborted()
    if (this.stopped) throw cancelled()
    const record = document.orderWatch.records.find(
      (entry) =>
        entry.accountId === run.accountId &&
        entry.revision === run.revision &&
        entry.enabled,
    )
    const account = document.accounts.find((entry) => entry.id === run.accountId)
    if (
      !record ||
      !account ||
      parseHomepage(account.homepageUrl).url !== run.homepageUrl
    ) {
      throw cancelled('账号主页或查询设置已变更')
    }
    return record
  }

  private async mutateCurrent<T>(
    run: ActiveRun,
    apply: (record: OrderWatchRecord, document: StoreDocument) => T,
  ): Promise<T> {
    return this.store.mutate((document) => apply(this.current(document, run), document))
  }

  private async execute(run: ActiveRun): Promise<void> {
    const deadline = setTimeout(() => run.controller.abort(), RUN_TIMEOUT_MS)
    deadline.unref()
    try {
      await this.mutateCurrent(run, (record, document) => {
        record.nextRunAt = this.nextRun(document.orderWatch.settings)
      })
      const source = this.sourceFactory()
      const snapshot = await source.scan(run.homepageUrl, run.controller.signal)
      try {
        await this.mutateCurrent(run, (record) => this.applySnapshot(record, snapshot))
      } catch (error) {
        if (error instanceof CandidateLimitError) await this.checkPending(run, source)
        throw error
      }
      await this.checkPending(run, source)
      await this.notifySold(run)
    } catch (error) {
      if (this.stopped) return
      try {
        await this.store.mutate((document) => {
          const record = document.orderWatch.records.find(
            (entry) =>
              entry.accountId === run.accountId && entry.revision === run.revision,
          )
          if (!record || !record.enabled) return
          record.lastError = run.controller.signal.aborted
            ? '本轮订单查询已中断，将在下次重试'
            : this.safeError(error)
          record.consecutiveFailures = Math.min(record.consecutiveFailures + 1, 32)
          const backoff = Math.min(
            120,
            5 * 2 ** Math.min(record.consecutiveFailures - 1, 5),
          )
          record.nextRunAt = new Date(
            this.now().getTime() +
              Math.max(document.orderWatch.settings.intervalMinutes, backoff) * 60_000,
          ).toISOString()
        })
        // Already-confirmed sales do not depend on a later successful wardrobe scan.
        if (!run.controller.signal.aborted) await this.notifySold(run)
      } catch {
        this.logger.warn('订单查询结果保存失败，保留上次已保存记录')
      }
    } finally {
      clearTimeout(deadline)
    }
  }

  private applySnapshot(record: OrderWatchRecord, snapshot: SnapshotItem[]): void {
    const now = this.now().toISOString()
    const current = new Set(snapshot.map((item) => item.id))
    for (const candidate of record.candidates) {
      if (candidate.status !== 'reappeared' && current.has(candidate.itemId)) {
        candidate.status = 'reappeared'
      }
    }
    const active = new Set(
      record.candidates
        .filter((candidate) => candidate.status !== 'reappeared')
        .map((candidate) => candidate.itemId),
    )
    for (const item of record.snapshot ?? []) {
      if (current.has(item.id) || active.has(item.id)) continue
      record.candidates.push({
        id: randomUUID(),
        itemId: item.id,
        itemUrl: item.url,
        title: item.title,
        imageUrl: item.imageUrl,
        lastSeenAt: record.lastCompleteAt,
        missingAt: now,
        checkedAt: null,
        status: 'pending',
        checkError: null,
        notifiedAt: null,
        notifyError: null,
      })
    }
    const historical = record.candidates.filter(
      (candidate) => candidate.status === 'reappeared' || candidate.notifiedAt !== null,
    )
    const unresolved = record.candidates.length - historical.length
    if (unresolved > MAX_CANDIDATES) throw new CandidateLimitError()
    const historyCount = Math.min(MAX_HISTORY, MAX_CANDIDATES - unresolved)
    const retained = new Set(
      historyCount === 0
        ? []
        : historical.slice(-historyCount).map((candidate) => candidate.id),
    )
    record.candidates = record.candidates.filter(
      (candidate) =>
        (candidate.status !== 'reappeared' && candidate.notifiedAt === null) ||
        retained.has(candidate.id),
    )
    record.snapshot = snapshot
    record.lastCompleteAt = now
    record.lastError = null
    record.consecutiveFailures = 0
  }

  private async checkPending(run: ActiveRun, source: OrderSource): Promise<void> {
    const record = this.current(await this.store.read(), run)
    const pending = record.candidates
      .filter((candidate) => candidate.status === 'pending')
      .sort(
        (a, b) =>
          (a.checkedAt === null ? 0 : Date.parse(a.checkedAt)) -
          (b.checkedAt === null ? 0 : Date.parse(b.checkedAt)),
      )
      .slice(0, MAX_CHECKS)
    for (const [index, candidate] of pending.entries()) {
      if (index && this.checkDelayMs) {
        await delay(this.checkDelayMs, undefined, { signal: run.controller.signal })
      }
      this.current(await this.store.read(), run)
      const result = await source.check(
        {
          id: candidate.itemId,
          title: candidate.title,
          url: candidate.itemUrl,
          imageUrl: candidate.imageUrl,
        },
        run.homepageUrl,
        run.controller.signal,
      )
      await this.mutateCurrent(run, (latest) => {
        const found = latest.candidates.find((entry) => entry.id === candidate.id)
        if (!found || found.status !== 'pending') return
        found.checkedAt = this.now().toISOString()
        found.checkError = result.error
        if (result.sold) found.status = 'sold'
      })
      if (result.error?.includes('429')) break
    }
  }

  private async notifySold(run: ActiveRun): Promise<void> {
    const record = this.current(await this.store.read(), run)
    const candidates = record.candidates
      .filter((candidate) => candidate.status === 'sold' && !candidate.notifiedAt)
      .slice(0, MAX_CHECKS)
    for (const candidate of candidates) {
      const document = await this.store.read()
      const latest = this.current(document, run)
      const current = latest.candidates.find((entry) => entry.id === candidate.id)
      if (!current || current.notifiedAt || current.status !== 'sold') continue
      const settings = document.orderWatch.settings.bark
      if (!settings.enabled) return
      const account = document.accounts.find((entry) => entry.id === run.accountId)!
      let error: string | null = null
      try {
        await sendBark(
          settings,
          {
            title: 'Vinted 商品已售',
            body: `${account.account}\n${current.title}`,
            url: current.itemUrl,
          },
          { ...this.fetchOptions(), signal: run.controller.signal },
        )
      } catch (failure) {
        run.controller.signal.throwIfAborted()
        error = this.safeError(failure)
      }
      await this.mutateCurrent(run, (latest) => {
        const found = latest.candidates.find((entry) => entry.id === candidate.id)
        if (!found || found.status !== 'sold' || found.notifiedAt) return
        found.notifyError = error
        if (error === null) found.notifiedAt = this.now().toISOString()
      })
      if (error) break
    }
  }

  private fetchOptions(): { fetchImpl?: typeof fetch } {
    return this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }
  }

  private nextRun(settings: OrderWatchSettings): string {
    return new Date(
      this.now().getTime() + settings.intervalMinutes * 60_000,
    ).toISOString()
  }

  private safeError(error: unknown): string {
    return isPluginFailure(error)
      ? error.message.slice(0, 500)
      : '订单查询失败，请稍后重试'
  }
}
