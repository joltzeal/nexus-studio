import { randomUUID } from 'node:crypto'

import { invalidRequest, notConfigured, unavailable } from '../domain/errors.js'
import {
  normalizeAllocation,
  normalizeApps,
  normalizeCategories,
  normalizeFilterApps,
  normalizeFilterDetail,
  normalizeOrders,
  normalizePrefixes,
  normalizeProfile,
  normalizePurchased,
  normalizeTel,
  num,
  pick,
  asRecord,
  text,
} from '../domain/normalize.js'
import { extractOtp } from '../domain/otp.js'
import {
  findRecord,
  mergeRecords,
  recordKey,
  removeRecord,
  searchRecords,
  withLastRead,
} from '../domain/records.js'
import {
  BuyCreateInputSchema,
  BuyDeferredInputSchema,
  CatalogAppsInputSchema,
  ChangeTokenInputSchema,
  ConfigSetInputSchema,
  EmptyInputSchema,
  FilterCreateInputSchema,
  FilterDetailInputSchema,
  OrderNumInputSchema,
  OrdersListInputSchema,
  PrefixesInputSchema,
  RecordTelInputSchema,
  RecordsListInputSchema,
  RenewIdsInputSchema,
  RenewTextInputSchema,
  SmsReadInputSchema,
  parseOrThrow,
} from '../domain/schemas.js'
import type { PurchasedApi, RenewReport, SmsRead, SmsRecord } from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import { Sim8Client, normalizeBaseUrl, normalizeToken } from '../services/client.js'
import type { PrivateStore } from '../store/private-store.js'
import type { SecretVault } from '../store/secret-vault.js'

export const SIM8_METHODS = [
  // Configuration and identity.
  'sim8.config.get',
  'sim8.config.set',
  'sim8.profile',
  // Projects.
  'sim8.catalog.categories',
  'sim8.catalog.apps',
  // Purchasing.
  'sim8.buy.prefixes',
  'sim8.buy.create',
  'sim8.buy.deferred',
  // Orders and their record links.
  'sim8.orders.list',
  'sim8.orders.apis',
  'sim8.orders.one',
  'sim8.orders.changeToken',
  'sim8.orders.renewText',
  'sim8.orders.renewIds',
  // Number filtering.
  'sim8.filter.apps',
  'sim8.filter.create',
  'sim8.filter.detail',
  // Local number list.
  'sim8.records.list',
  'sim8.records.remove',
  'sim8.records.clear',
  // Reading a code off a record link.
  'sim8.sms.read',
] as const

/** A record page is small; anything larger is a misconfigured link. */
const MAX_SMS_BODY = 256 * 1024
/**
 * The raw body travels back to the page for the "查看原文" panel. A single RPC
 * message is capped at 1 MiB and JSON escaping can double the size.
 */
const MAX_SMS_PREVIEW = 64 * 1024
/** A purchase of thousands of numbers cannot be rendered; the store keeps them. */
const MAX_RESPONSE_RECORDS = 200
const SMS_TIMEOUT_MS = 20_000
/** Purchasing allocates numbers on the provider side, so it needs longer. */
const BUY_TIMEOUT_MS = 60_000

export interface Sim8ProviderOptions {
  store: PrivateStore
  vault: SecretVault
  logger: Logger
  now?: () => Date
  fetchImpl?: typeof fetch
  /** Keeps `buy/deferred` idempotent when the page retries. */
  requestIdFactory?: () => string
}

/**
 * `verification.provider` over the SIM8 API: buy numbers, keep the record links
 * the provider hands out, and read the code from them.
 *
 * The provider's own order endpoints are searchable by order number only, so the
 * plugin also keeps a local list of every number it has seen. That list is what
 * the page browses; the provider stays the source of truth for the numbers
 * themselves.
 */
export class Sim8Provider {
  readonly id = 'verification.provider'
  readonly name = 'SIM8 接码'

  private readonly store: PrivateStore
  private readonly vault: SecretVault
  private readonly logger: Logger
  private readonly now: () => Date
  private readonly fetchImpl: typeof fetch | null
  private readonly requestIdFactory: () => string

  constructor(options: Sim8ProviderOptions) {
    this.store = options.store
    this.vault = options.vault
    this.logger = options.logger
    this.now = options.now ?? (() => new Date())
    this.fetchImpl = options.fetchImpl ?? null
    this.requestIdFactory = options.requestIdFactory ?? randomUUID
  }

  status(): Record<string, unknown> {
    return {
      storage: this.store.kind,
      storageDurable: this.store.durable,
    }
  }

  async call(context: DispatchContext): Promise<unknown> {
    switch (context.method) {
      case 'sim8.config.get':
        return await this.configGet(context)
      case 'sim8.config.set':
        return await this.configSet(context)
      case 'sim8.profile':
        return await this.profile(context)
      case 'sim8.catalog.categories':
        return await this.categories(context)
      case 'sim8.catalog.apps':
        return await this.apps(context)
      case 'sim8.buy.prefixes':
        return await this.prefixes(context)
      case 'sim8.buy.create':
        return await this.buyCreate(context)
      case 'sim8.buy.deferred':
        return await this.buyDeferred(context)
      case 'sim8.orders.list':
        return await this.ordersList(context)
      case 'sim8.orders.apis':
        return await this.ordersApis(context)
      case 'sim8.orders.one':
        return await this.ordersOne(context)
      case 'sim8.orders.changeToken':
        return await this.changeToken(context)
      case 'sim8.orders.renewText':
        return await this.renewText(context)
      case 'sim8.orders.renewIds':
        return await this.renewIds(context)
      case 'sim8.filter.apps':
        return await this.filterApps(context)
      case 'sim8.filter.create':
        return await this.filterCreate(context)
      case 'sim8.filter.detail':
        return await this.filterDetail(context)
      case 'sim8.records.list':
        return await this.recordsList(context)
      case 'sim8.records.remove':
        return await this.recordsRemove(context)
      case 'sim8.records.clear':
        return await this.recordsClear(context)
      case 'sim8.sms.read':
        return await this.readSms(context)
      default:
        throw invalidRequest('插件不支持该方法')
    }
  }

  /** A client needs a token; every API method goes through here. */
  private async client(timeoutMs?: number): Promise<Sim8Client> {
    const document = await this.store.read()
    const ref = document.config.tokenRef
    if (ref === null) {
      throw notConfigured('还没有填写 SIM8 接口 Token，请在设置里填写')
    }
    const token = await this.vault.resolve(ref)
    return new Sim8Client({
      baseUrl: document.config.baseUrl,
      token,
      ...(this.fetchImpl === null ? {} : { fetchImpl: this.fetchImpl }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })
  }

  private view(document: {
    config: {
      baseUrl: string
      tokenRef: string | null
      profile: unknown
      profileAt: string | null
    }
    records: readonly unknown[]
  }): Record<string, unknown> {
    return {
      baseUrl: document.config.baseUrl,
      hasToken: document.config.tokenRef !== null,
      profile: document.config.profile,
      profileAt: document.config.profileAt,
      records: document.records.length,
      storageDurable: this.store.durable,
    }
  }

  private async configGet(context: DispatchContext): Promise<unknown> {
    const document = await this.store.read()
    context.assertAlive()
    return this.view(document)
  }

  /**
   * Saves the token and the base URL. A new token is verified against
   * `profile/info` before it is stored: an invalid token saved silently would
   * turn every later call into the same error.
   */
  private async configSet(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(ConfigSetInputSchema, context.payload)
    const document = await this.store.read()
    const baseUrl =
      input.baseUrl === undefined
        ? document.config.baseUrl
        : normalizeBaseUrl(input.baseUrl)

    let tokenRef = document.config.tokenRef
    let profile = document.config.profile
    let profileAt = document.config.profileAt

    if (input.token === null) {
      if (tokenRef !== null) await this.vault.drop(tokenRef)
      tokenRef = null
      profile = null
      profileAt = null
    } else if (input.token !== undefined) {
      const token = normalizeToken(input.token)
      if (token === '') throw invalidRequest('接口 Token 不能为空；要清除请传 null')
      const candidate = new Sim8Client({
        baseUrl,
        token,
        ...(this.fetchImpl === null ? {} : { fetchImpl: this.fetchImpl }),
      })
      const info = normalizeProfile(await candidate.get('/api/v1/profile/info'))
      context.assertAlive()
      const stored = await this.vault.put('api-token', token)
      if (tokenRef !== null) await this.vault.drop(tokenRef)
      tokenRef = stored.ref
      profile = info
      profileAt = this.now().toISOString()
    }

    const next = { baseUrl, tokenRef, profile, profileAt }
    await this.store.mutate((draft) => {
      draft.config = next
    })
    context.assertAlive()
    this.logger.info('接口配置已更新', {
      baseUrl,
      hasToken: tokenRef !== null,
    })
    return this.view({ config: next, records: document.records })
  }

  private async profile(context: DispatchContext): Promise<unknown> {
    const client = await this.client()
    const info = normalizeProfile(await client.get('/api/v1/profile/info'))
    const profileAt = this.now().toISOString()
    context.assertAlive()
    await this.store.mutate((draft) => {
      draft.config.profile = info
      draft.config.profileAt = profileAt
    })
    return { profile: info, profileAt }
  }

  private async categories(context: DispatchContext): Promise<unknown> {
    const client = await this.client()
    const data = await client.get('/api/v1/app/cate')
    context.assertAlive()
    return normalizeCategories(data)
  }

  private async apps(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(CatalogAppsInputSchema, context.payload)
    const client = await this.client()
    const data = await client.post('/api/v1/app/list', {
      cate_id: input.cateId ?? 2,
      type: input.type ?? 1,
      ...(input.name === undefined ? {} : { name: input.name }),
    })
    context.assertAlive()
    return normalizeApps(data)
  }

  private async prefixes(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(PrefixesInputSchema, context.payload)
    const client = await this.client()
    const data = await client.post('/api/v1/buy/prefix', {
      app_id: input.appId,
      type: input.type ?? 1,
      expiry: input.expiry ?? 0,
    })
    context.assertAlive()
    return normalizePrefixes(data)
  }

  /**
   * Buys numbers. The provider may report the same number twice (in `list` and
   * in `url_list`), which the normalizer folds into one row.
   */
  private async buyCreate(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(BuyCreateInputSchema, context.payload)
    const client = await this.client(BUY_TIMEOUT_MS)
    const data = await client.post('/api/v1/buy/create', {
      app_id: input.appId,
      num: input.num,
      type: input.type ?? 1,
      expiry: input.expiry ?? 0,
      ...(input.prefix === undefined || input.prefix === ''
        ? {}
        : { prefix: input.prefix }),
      ...(input.excludePrefix === undefined || input.excludePrefix === ''
        ? {}
        : { exclude_prefix: input.excludePrefix }),
    })
    context.assertAlive()
    const source = asRecord(data) ?? {}
    const ordernum = text(pick(source, ['ordernum', 'order_num']))
    const items = normalizePurchased(data, ordernum)
    const stored = await this.saveRecords(items)
    this.logger.info('购买完成', {
      ordernum,
      requested: input.num,
      received: items.length,
      appId: input.appId,
    })
    return {
      ordernum,
      apiCount: num(pick(source, ['api_count'])) ?? items.length,
      requested: input.num,
      total: items.length,
      truncated: items.length > MAX_RESPONSE_RECORDS,
      records: stored.slice(0, MAX_RESPONSE_RECORDS),
    }
  }

  /**
   * Defers allocation: the order is queued and numbers appear later, so the
   * answer carries a status instead of record links.
   */
  private async buyDeferred(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(BuyDeferredInputSchema, context.payload)
    const client = await this.client(BUY_TIMEOUT_MS)
    const data = await client.post('/api/v1/buy/deferred', {
      app_id: input.appId,
      num: input.num,
      type: input.type ?? 1,
      expiry: input.expiry ?? 0,
      request_id: input.requestId ?? this.requestIdFactory(),
      ...(input.prefix === undefined || input.prefix === ''
        ? {}
        : { prefix: input.prefix }),
      ...(input.excludePrefix === undefined || input.excludePrefix === ''
        ? {}
        : { exclude_prefix: input.excludePrefix }),
    })
    context.assertAlive()
    const state = normalizeAllocation(data)
    this.logger.info('后分配下单', {
      ordernum: state.ordernum,
      status: state.allocationStatus,
      requested: state.requestedNum,
    })
    return state
  }

  private async ordersList(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(OrdersListInputSchema, context.payload)
    const client = await this.client()
    const data = await client.post('/api/v1/order/list', {
      page: input.page ?? 1,
      limit: input.limit ?? 20,
      ...(input.ordernum === undefined ? {} : { ordernum: input.ordernum }),
      ...(input.cateId === undefined ? {} : { cate_id: input.cateId }),
      ...(input.appId === undefined ? {} : { app_id: input.appId }),
      ...(input.type === undefined ? {} : { type: input.type }),
      ...(input.createTimeStart === undefined
        ? {}
        : { create_time_start: input.createTimeStart }),
      ...(input.createTimeEnd === undefined
        ? {}
        : { create_time_end: input.createTimeEnd }),
    })
    context.assertAlive()
    return normalizeOrders(data)
  }

  /**
   * Every record link of one order. This is also how a deferred order is
   * collected once its allocation finished.
   */
  private async ordersApis(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(OrderNumInputSchema, context.payload)
    const client = await this.client()
    const data = await client.post('/api/v1/order/api', { ordernum: input.ordernum })
    context.assertAlive()
    const items = normalizePurchased(data, input.ordernum)
    const stored = await this.saveRecords(items)
    const allocation = normalizeAllocation(data, input.ordernum)
    this.logger.info('已同步订单号码', {
      ordernum: input.ordernum,
      count: items.length,
      status: allocation.allocationStatus,
    })
    return {
      ordernum: input.ordernum,
      total: items.length,
      truncated: items.length > MAX_RESPONSE_RECORDS,
      records: stored.slice(0, MAX_RESPONSE_RECORDS),
      allocation,
    }
  }

  private async ordersOne(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(OrderNumInputSchema, context.payload)
    const client = await this.client()
    const data = await client.post('/api/v1/order/apiOnce', { ordernum: input.ordernum })
    context.assertAlive()
    const items = normalizePurchased(data, input.ordernum)
    if (items.length === 0) throw invalidRequest('这个订单还没有分配号码')
    const stored = await this.saveRecords(items)
    return { record: stored[0] ?? null }
  }

  /** Rotates the record link of one number; the old link stops working. */
  private async changeToken(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(ChangeTokenInputSchema, context.payload)
    const client = await this.client()
    const data = await client.post('/api/v1/order/changeToken', { id: input.apiId })
    context.assertAlive()
    const items = normalizePurchased(data)
    const stored = await this.saveRecords(items)
    this.logger.info('接码链接已更换', { apiId: input.apiId, tel: stored[0]?.tel ?? '' })
    return { record: stored[0] ?? null }
  }

  private async renewText(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(RenewTextInputSchema, context.payload)
    const text = input.text ?? (await this.renewalText(input.tels ?? []))
    const client = await this.client(BUY_TIMEOUT_MS)
    const data = await client.post('/api/v1/order/renewApiText', { api: text })
    context.assertAlive()
    const source = asRecord(data) ?? {}
    const items = normalizePurchased(data)
    const stored = await this.saveRecords(items)
    const failedList = Array.isArray(source['failed_list'])
      ? (source['failed_list'] as unknown[]).map((entry) => textOf(entry)).filter(Boolean)
      : []
    const report: RenewReport = {
      success: num(pick(source, ['success'])) ?? items.length,
      failed: num(pick(source, ['failed'])) ?? failedList.length,
      failedList,
      total: num(pick(source, ['total'])) ?? items.length,
      records: stored,
    }
    this.logger.info('批量续费完成', {
      success: report.success,
      failed: report.failed,
    })
    return report
  }

  private async renewalText(tels: readonly string[]): Promise<string> {
    if (tels.length === 0) throw invalidRequest('没有可续费的号码')
    const document = await this.store.read()
    const lines: string[] = []
    for (const tel of tels) {
      const record = findRecord(document.records, tel)
      if (record === undefined) throw invalidRequest(`没有 ${tel} 的记录`)
      if (record.api === '') throw invalidRequest(`${tel} 没有接码链接，无法续费`)
      lines.push(`+${record.tel.replace(/^\+/, '')}----${record.api}`)
    }
    return lines.join('\n')
  }

  /** The API answers with the renewed ids only; the page re-syncs the order. */
  private async renewIds(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(RenewIdsInputSchema, context.payload)
    const client = await this.client(BUY_TIMEOUT_MS)
    const data = await client.post('/api/v1/order/renewApis', {
      ids: input.ids.join(','),
    })
    context.assertAlive()
    const source = asRecord(data) ?? {}
    const ids = text(pick(source, ['ids']))
    this.logger.info('按 ID 续费完成', { requested: input.ids.length, ids })
    return { ids }
  }

  private async filterApps(context: DispatchContext): Promise<unknown> {
    const client = await this.client()
    const data = await client.get('/api/v1/filter/app')
    context.assertAlive()
    return normalizeFilterApps(data)
  }

  /**
   * `filter/create` is multipart: the number list travels as a txt file, one
   * number per line with its country code, exactly as the provider documents.
   */
  private async filterCreate(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(FilterCreateInputSchema, context.payload)
    const client = await this.client(BUY_TIMEOUT_MS)
    const form = new FormData()
    form.append('app_id', String(input.appId))
    form.append('code', input.code)
    const body = `${input.numbers.join('\n')}\n`
    form.append('file', new Blob([body], { type: 'text/plain' }), 'numbers.txt')
    const data = await client.postForm('/api/v1/filter/create', form)
    context.assertAlive()
    const source = asRecord(data) ?? {}
    const orderId = num(pick(source, ['order_id']))
    if (orderId === null) throw unavailable('筛选订单已提交，但接口没有返回订单 ID')
    this.logger.info('筛选订单已创建', { orderId, count: input.numbers.length })
    return { orderId, count: input.numbers.length }
  }

  private async filterDetail(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(FilterDetailInputSchema, context.payload)
    const client = await this.client()
    const data = await client.get('/api/v1/filter/detail', { order_id: input.orderId })
    context.assertAlive()
    return normalizeFilterDetail(data)
  }

  private async recordsList(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(RecordsListInputSchema, context.payload)
    const document = await this.store.read()
    context.assertAlive()
    const items = searchRecords(document.records, input.query ?? '')
    return {
      items,
      total: document.records.length,
      matched: items.length,
      storageDurable: this.store.durable,
    }
  }

  private async recordsRemove(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(RecordTelInputSchema, context.payload)
    const removed = await this.store.mutate((draft) => {
      const result = removeRecord(draft.records, input.tel)
      draft.records = result.records
      return result.removed
    })
    context.assertAlive()
    return { tel: normalizeTel(input.tel), removed }
  }

  private async recordsClear(context: DispatchContext): Promise<unknown> {
    parseOrThrow(EmptyInputSchema, context.payload)
    const before = await this.store.mutate((draft) => {
      const count = draft.records.length
      draft.records = []
      return count
    })
    context.assertAlive()
    return { removed: before }
  }

  /**
   * Reads the code off one record link. The link carries its own token, so it is
   * fetched without the account token and never echoed back in an error.
   */
  private async readSms(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(SmsReadInputSchema, context.payload)
    const document = await this.store.read()
    let url = input.url ?? ''
    let tel = input.tel === undefined ? '' : normalizeTel(input.tel)
    if (input.tel !== undefined) {
      const record = findRecord(document.records, input.tel)
      if (record === undefined) {
        throw invalidRequest('没有这个号码的记录，请先购买或从订单同步')
      }
      url = record.api
      tel = record.tel
    }
    if (url === '') throw invalidRequest('这个号码还没有接码链接')

    const doFetch = this.fetchImpl ?? globalThis.fetch
    let response: Response
    try {
      response = await doFetch(url, {
        redirect: 'follow',
        headers: { accept: 'application/json,text/plain,text/html' },
        signal: AbortSignal.timeout(SMS_TIMEOUT_MS),
      })
    } catch (error) {
      throw unavailable('接码链接请求失败，请检查链接是否仍然有效', error)
    }
    if (!response.ok) {
      throw unavailable(`接码链接返回 HTTP ${String(response.status)}`)
    }
    const body = (await response.text()).slice(0, MAX_SMS_BODY)
    context.assertAlive()
    const contentType = response.headers.get('content-type') ?? ''
    const code = extractOtp(body, contentType)
    const result: SmsRead = {
      code,
      body: body.slice(0, MAX_SMS_PREVIEW),
      truncated: body.length > MAX_SMS_PREVIEW,
      contentType,
      fetchedAt: this.now().toISOString(),
    }
    if (tel !== '') {
      const record = findRecord(document.records, tel)
      if (record !== undefined) {
        await this.store.mutate((draft) => {
          draft.records = draft.records.map((entry) =>
            recordKey(entry.tel) === recordKey(tel) ? withLastRead(entry, result) : entry,
          )
        })
      }
    }
    // The code itself stays out of the log line.
    this.logger.info('已读取验证码', { tel, found: code !== null })
    return { tel, result }
  }

  /** Merges numbers into the local list and returns the rows for those numbers. */
  private async saveRecords(items: readonly PurchasedApi[]): Promise<SmsRecord[]> {
    if (items.length === 0) return []
    const now = this.now().toISOString()
    return await this.store.mutate((draft) => {
      draft.records = mergeRecords(draft.records, items, now)
      const keys = new Set(items.map((item) => recordKey(item.tel)))
      return draft.records.filter((record) => keys.has(recordKey(record.tel)))
    })
  }
}

/** `failed_list` entries are either lines or objects with a message. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  const row = asRecord(value)
  if (row === null) return ''
  return text(pick(row, ['api', 'msg', 'message', 'tel']))
}
