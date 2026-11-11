import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { AccountPool as AccountPoolContract } from '@nexus/plugin-sdk'
import {
  WINDOW_DETACH_METHOD,
  WindowDetachInputSchema,
  type WindowDetachInput,
  type WindowDetachResult,
} from '@nexus/plugin-sdk/lifecycle'

import { invalidRequest, unavailable } from '../domain/errors.js'
import {
  AccountAddressSetInputSchema,
  AccountAddressTargetsInputSchema,
} from '../domain/address.js'
import {
  TEMPLATE_HEADERS,
  normalizeHomepage,
  parseAccountRows,
} from '../domain/import.js'
import {
  AccountIdInputSchema,
  AccountSaveInputSchema,
  BindInputSchema,
  ImportInputSchema,
  OtpInputSchema,
  TemplateInputSchema,
  WindowIdInputSchema,
  parseOrThrow,
} from '../domain/schemas.js'
import { extractOtp } from '../domain/otp.js'
import { buildXlsx, parseCsv, parseXlsx, serializeCsv } from '../domain/table.js'
import type {
  AccountRecord,
  BindingRecord,
  ImportReport,
  TemplateFile,
} from '../domain/types.js'
import {
  DEFAULT_MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  type DispatchContext,
} from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import type { AccountStore } from '../store/account-store.js'
import type { OrderSource } from '../services/order-source.js'
import { AccountOrderWatch, ORDER_WATCH_METHODS } from './order-watch.js'
import {
  TRANSFER_METHODS,
  exportAccounts,
  finishAccountsTransfer,
  importAccounts,
} from './transfer.js'

export const ACCOUNT_METHODS = [
  'vinted.accounts.list',
  'vinted.accounts.save',
  'vinted.accounts.remove',
  'vinted.accounts.import',
  'vinted.accounts.template',
  'vinted.accounts.otp',
  'vinted.accounts.bind',
  'vinted.accounts.unbind',
  'vinted.accounts.bindings',
  'vinted.accounts.address.targets',
  'vinted.accounts.address.set',
  WINDOW_DETACH_METHOD,
  ...TRANSFER_METHODS,
  ...ORDER_WATCH_METHODS,
] as const

/** One JSON document holds everything, so growth must stay bounded. */
export const MAX_ACCOUNTS = 2000
/** A broken export can produce a thousand identical errors; show the first few. */
export const MAX_IMPORT_ERRORS = 50

// Full records include three 2048-character URLs and an address. JSON escaping
// can cost six bytes per character; leave room for each account's window bindings.
const ACCOUNT_PAGE_SIZE = 16
const AccountListInputSchema = z.strictObject({
  page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  pageSize: z.number().int().min(1).max(ACCOUNT_PAGE_SIZE).default(ACCOUNT_PAGE_SIZE),
  revision: z.string().min(1).max(128).optional(),
})

const CSV_MIME = 'text/csv;charset=utf-8'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** A mailbox page is small; anything larger is a misconfigured link. */
const MAX_OTP_BODY = 512 * 1024
/**
 * The raw body travels back to the page for the "查看原文" panel. A single RPC
 * message is capped at 1 MiB, and JSON escaping can double the size, so this
 * stays well below the parsing limit.
 */
const MAX_OTP_PREVIEW = 64 * 1024
const OTP_TIMEOUT_MS = 20_000

export interface AccountPoolOptions {
  store: AccountStore
  logger: Logger
  now?: () => Date
  idFactory?: () => string
  /** Injected so a test can answer an inbox link without a network. */
  fetchImpl?: typeof fetch
  orderSourceFactory?: () => OrderSource
  orderCheckDelayMs?: number
}

/** Identity for duplicate detection: the same login on the same method. */
function keyOf(entry: { loginMethod: string; account: string }): string {
  return `${entry.loginMethod}\u0000${entry.account.toLowerCase()}`
}

export interface AccountBindingView extends BindingRecord {
  account: {
    id: string
    account: string
    loginMethod: string
    status: string
    note: string
  } | null
}

/**
 * `account.pool` capability: credential records, spreadsheet import and the
 * binding between an account and a browser window.
 *
 * The binding lives here, not in the host's profile store, because the account
 * table is the plugin's data. Window ids are opaque strings: the plugin never
 * learns a window name, so the page owns every message that mentions one.
 */
export class AccountPool implements AccountPoolContract {
  readonly id = 'account.pool'
  readonly name = 'Vinted 账号池'
  readonly orders: AccountOrderWatch

  private readonly store: AccountStore
  private readonly logger: Logger
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly fetchImpl: typeof fetch | null

  constructor(options: AccountPoolOptions) {
    this.store = options.store
    this.logger = options.logger
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? randomUUID
    this.fetchImpl = options.fetchImpl ?? null
    this.orders = new AccountOrderWatch({
      store: options.store,
      logger: options.logger,
      now: this.now,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.orderSourceFactory === undefined
        ? {}
        : { sourceFactory: options.orderSourceFactory }),
      ...(options.orderCheckDelayMs === undefined
        ? {}
        : { checkDelayMs: options.orderCheckDelayMs }),
    })
  }

  status(): Record<string, unknown> {
    return {
      storage: this.store.kind,
      storageDurable: this.store.durable,
    }
  }

  async call(context: DispatchContext): Promise<unknown> {
    if (ORDER_WATCH_METHODS.some((method) => method === context.method)) {
      return this.orders.call(context)
    }
    switch (context.method) {
      case 'transfer.export':
        return exportAccounts(this.store, context)
      case 'transfer.import':
        return importAccounts(this.store, context, MAX_ACCOUNTS)
      case 'transfer.rollback':
        return finishAccountsTransfer(this.store, context, true)
      case 'transfer.commit':
        return finishAccountsTransfer(this.store, context, false)
      case 'vinted.accounts.list':
        return await this.listAccounts(context)
      case 'vinted.accounts.address.targets':
        return await this.listAddressTargets(context)
      case 'vinted.accounts.address.set':
        return await this.setAddress(context)
      case 'vinted.accounts.save':
        return await this.saveAccount(context)
      case 'vinted.accounts.remove':
        return await this.removeAccount(context)
      case 'vinted.accounts.import':
        return await this.importAccounts(context)
      case 'vinted.accounts.template':
        return await this.template(context)
      case 'vinted.accounts.otp':
        return await this.readOtp(context)
      case 'vinted.accounts.bind':
        return await this.bind(context)
      case 'vinted.accounts.unbind':
        return await this.unbind(context)
      case WINDOW_DETACH_METHOD:
        return await this.detachWindow(
          parseOrThrow(WindowDetachInputSchema, context.payload),
          context.assertAlive,
        )
      case 'vinted.accounts.bindings':
        return await this.listBindings(context)
      default:
        throw invalidRequest('插件不支持该方法')
    }
  }

  private async listAccounts(context: DispatchContext): Promise<unknown> {
    const parsed = AccountListInputSchema.safeParse(
      context.payload === undefined ? {} : context.payload,
    )
    if (!parsed.success) throw invalidRequest('账号列表分页参数无效')
    const input = parsed.data
    context.assertAlive()
    const document = await this.store.read()
    context.assertAlive()
    // Canonical object keys keep the content revision stable across store reopens.
    // Array order remains significant because it determines page membership.
    const revision = createHash('sha256')
      .update(
        JSON.stringify(
          { accounts: document.accounts, bindings: document.bindings },
          (_key, value: unknown) =>
            value !== null && typeof value === 'object' && !Array.isArray(value)
              ? Object.fromEntries(
                  Object.entries(value).sort(([left], [right]) =>
                    left < right ? -1 : left > right ? 1 : 0,
                  ),
                )
              : value,
        ),
      )
      .digest('hex')
    if (input.revision !== undefined && input.revision !== revision) {
      throw invalidRequest('账号列表已变化，请刷新后重试。')
    }
    const start = (input.page - 1) * input.pageSize
    const items = document.accounts.slice(start, start + input.pageSize)
    const ids = new Set(items.map((account) => account.id))
    const result = {
      items,
      total: document.accounts.length,
      bindings: document.bindings.filter((binding) => ids.has(binding.accountId)),
      storageDurable: this.store.durable,
      page: input.page,
      pageSize: input.pageSize,
      revision,
    }
    const response = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: context.requestId,
      ok: true,
      result,
    }
    if (
      Buffer.byteLength(`${JSON.stringify(response)}\n`, 'utf8') >= DEFAULT_MAX_LINE_BYTES
    ) {
      throw unavailable(
        '账号列表单页数据过大，超过消息大小上限，请减少每页账号数后重试。',
      )
    }
    context.assertAlive()
    return result
  }

  private async saveAccount(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(AccountSaveInputSchema, context.payload)
    const now = this.now().toISOString()
    const fields = {
      loginMethod: input.loginMethod,
      account: input.account,
      password: input.password,
      phone: input.phone,
      emailOtpUrl: input.emailOtpUrl,
      smsOtpUrl: input.smsOtpUrl,
      note: input.note,
      status: input.status,
      homepageUrl: normalizeHomepage(input.homepageUrl),
    }

    const result = await this.store.mutate((document) => {
      const duplicate = document.accounts.find(
        (entry) => entry.id !== input.id && keyOf(entry) === keyOf(fields),
      )
      if (duplicate !== undefined) {
        throw invalidRequest(`账号 ${fields.account} 已存在，请直接编辑该记录`)
      }
      if (input.id === undefined) {
        if (document.accounts.length >= MAX_ACCOUNTS) {
          throw invalidRequest(`账号上限为 ${String(MAX_ACCOUNTS)} 个，请先删除部分账号`)
        }
        const created: AccountRecord = {
          id: this.idFactory(),
          ...fields,
          address: null,
          createdAt: now,
          updatedAt: now,
        }
        document.accounts.unshift(created)
        return { item: created, created: true }
      }
      const existing = document.accounts.find((entry) => entry.id === input.id)
      if (existing === undefined) throw invalidRequest('账号不存在或已被删除')
      Object.assign(existing, fields, { updatedAt: now })
      return { item: existing, created: false }
    })
    context.assertAlive()
    return result
  }

  private async removeAccount(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(AccountIdInputSchema, context.payload)
    const removed = await this.store.mutate((document) => {
      const before = document.accounts.length
      document.accounts = document.accounts.filter(
        (entry) => entry.id !== input.accountId,
      )
      // A binding without an account would leave a window pointing at nothing.
      document.bindings = document.bindings.filter(
        (entry) => entry.accountId !== input.accountId,
      )
      return before !== document.accounts.length
    })
    context.assertAlive()
    return { accountId: input.accountId, removed }
  }

  private async importAccounts(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(ImportInputSchema, context.payload)
    if ((input.text === undefined) === (input.base64 === undefined)) {
      throw invalidRequest('导入内容缺失或重复')
    }
    const table = this.readTable(input)
    const outcome = parseAccountRows(table)
    if (outcome.rows.length === 0 && outcome.errors.length === 0) {
      throw invalidRequest('文件里没有可导入的账号')
    }
    const now = this.now().toISOString()

    const report = await this.store.mutate((document) => {
      const byKey = new Map<string, AccountRecord>()
      for (const entry of document.accounts) byKey.set(keyOf(entry), entry)
      const created: AccountRecord[] = []
      let updated = 0
      for (const row of outcome.rows) {
        const existing = byKey.get(keyOf(row))
        if (existing === undefined) {
          const record: AccountRecord = {
            id: this.idFactory(),
            ...row,
            address: null,
            createdAt: now,
            updatedAt: now,
          }
          byKey.set(keyOf(record), record)
          created.push(record)
          continue
        }
        // An import refreshes the record it already knows, bindings included.
        Object.assign(existing, row, { updatedAt: now })
        updated += 1
      }
      if (document.accounts.length + created.length > MAX_ACCOUNTS) {
        throw invalidRequest(`导入后账号会超过 ${String(MAX_ACCOUNTS)} 个上限`)
      }
      document.accounts = [...created, ...document.accounts]
      const result: ImportReport = {
        total: outcome.rows.length + outcome.errors.length,
        inserted: created.length,
        updated,
        skipped: outcome.errors.length,
        errors: outcome.errors.slice(0, MAX_IMPORT_ERRORS),
      }
      return result
    })
    context.assertAlive()
    this.logger.info('账号导入完成', {
      inserted: report.inserted,
      updated: report.updated,
      skipped: report.skipped,
    })
    return report
  }

  private async listAddressTargets(context: DispatchContext): Promise<unknown> {
    const parsed = AccountAddressTargetsInputSchema.safeParse(context.payload)
    if (!parsed.success) throw invalidRequest('账号地址查询参数无效')
    const input = parsed.data
    const document = await this.store.read()
    context.assertAlive()
    const query = (input.query ?? '').toLowerCase()
    const matches = document.accounts.filter((account) =>
      [
        account.account,
        account.note,
        account.address?.city ?? '',
        account.address?.street ?? '',
      ].some((value) => value.toLowerCase().includes(query)),
    )
    const start = (input.page - 1) * input.pageSize
    return {
      items: matches.slice(start, start + input.pageSize).map((account) => ({
        id: account.id,
        account: account.account,
        status: account.status,
        address: account.address ?? null,
      })),
      total: matches.length,
      page: input.page,
      pageSize: input.pageSize,
      storageDurable: this.store.durable,
    }
  }

  private async setAddress(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(AccountAddressSetInputSchema, context.payload)
    context.assertAlive()
    return await this.store.mutate((document) => {
      context.assertAlive()
      const account = document.accounts.find((entry) => entry.id === input.accountId)
      if (account === undefined) throw invalidRequest('账号不存在或已被删除')
      if (
        input.expectedProfileId !== undefined &&
        input.expectedProfileId !== (account.address?.id ?? null)
      ) {
        throw invalidRequest('账号地址已变化，请刷新后重试')
      }
      const updatedAt = this.now().toISOString()
      const address =
        input.profile === null ? null : { ...input.profile, linkedAt: updatedAt }
      account.address = address
      account.updatedAt = updatedAt
      return { address, updatedAt, storageDurable: this.store.durable }
    })
  }

  /** Spreadsheet bytes in, a cell grid out; the extension only picks the parser. */
  private readTable(input: {
    filename: string
    text?: string | undefined
    base64?: string | undefined
  }): string[][] {
    if (input.text !== undefined) return parseCsv(input.text)
    const base64 = (input.base64 ?? '').replace(/\s+/g, '')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      throw invalidRequest('导入文件编码无效，请重新选择文件')
    }
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length === 0) throw invalidRequest('导入文件为空')
    const name = input.filename.toLowerCase()
    if (name.endsWith('.xls')) {
      throw invalidRequest('暂不支持 .xls，请在表格软件里另存为 .xlsx 或 .csv')
    }
    if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) return parseXlsx(bytes)
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return parseXlsx(bytes)
    return parseCsv(bytes.toString('utf8'))
  }

  private async template(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(TemplateInputSchema, context.payload)
    const header = [[...TEMPLATE_HEADERS]]
    if (input.format === 'csv') {
      // The BOM is what makes Excel on Windows read the Chinese headers.
      const text = `\uFEFF${serializeCsv(header)}\r\n`
      const file: TemplateFile = {
        filename: 'vinted-accounts-template.csv',
        mimeType: CSV_MIME,
        base64: Buffer.from(text, 'utf8').toString('base64'),
      }
      return file
    }
    const file: TemplateFile = {
      filename: 'vinted-accounts-template.xlsx',
      mimeType: XLSX_MIME,
      base64: Buffer.from(buildXlsx(header)).toString('base64'),
    }
    return file
  }

  /**
   * Reads the account's own inbox link and pulls the code out of the answer.
   * The URL is never echoed back: it usually carries a one-time token.
   */
  private async readOtp(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(OtpInputSchema, context.payload)
    const document = await this.store.read()
    context.assertAlive()
    const account = document.accounts.find((entry) => entry.id === input.accountId)
    if (account === undefined) throw invalidRequest('账号不存在或已被删除')
    const url = input.channel === 'email' ? account.emailOtpUrl : account.smsOtpUrl
    if (url === '') {
      throw invalidRequest(
        input.channel === 'email'
          ? '这个账号没有填写邮箱验证码链接'
          : '这个账号没有填写手机验证码链接',
      )
    }

    const doFetch = this.fetchImpl ?? globalThis.fetch
    let response: Response
    try {
      response = await doFetch(url, {
        redirect: 'follow',
        headers: { accept: 'text/html,application/json,text/plain' },
        signal: AbortSignal.timeout(OTP_TIMEOUT_MS),
      })
    } catch (error) {
      throw unavailable('取码链接请求失败，请检查链接是否可以访问', error)
    }
    if (!response.ok) {
      throw unavailable(`取码链接返回 ${String(response.status)}，无法获取验证码`)
    }
    const body = (await response.text()).slice(0, MAX_OTP_BODY)
    context.assertAlive()
    const contentType = response.headers.get('content-type') ?? ''
    const code = extractOtp(body, contentType)
    // The code itself is deliberately left out of the log line.
    this.logger.info('已读取验证码', {
      accountId: account.id,
      channel: input.channel,
      found: code !== null,
    })
    // A missing code is an answer, not a failure: the page shows "还没有验证码"
    // and offers the raw body, which is what makes the next attempt debuggable.
    return {
      channel: input.channel,
      code,
      body: body.slice(0, MAX_OTP_PREVIEW),
      truncated: body.length > MAX_OTP_PREVIEW,
      contentType,
      fetchedAt: this.now().toISOString(),
    }
  }

  private async bind(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(BindInputSchema, context.payload)
    const document = await this.store.read()
    const account = document.accounts.find((entry) => entry.id === input.accountId)
    if (account === undefined) throw invalidRequest('账号不存在或已被删除')
    const duplicates = document.bindings
      .filter(
        (entry) =>
          entry.accountId === input.accountId && entry.windowId !== input.windowId,
      )
      .map((entry) => entry.windowId)
    if (duplicates.length > 0 && input.confirmDuplicates !== true) {
      // Nothing is written: the page shows the warning and asks again.
      return { bound: false, duplicates }
    }
    const binding: BindingRecord = {
      windowId: input.windowId,
      accountId: input.accountId,
      boundAt: this.now().toISOString(),
    }
    await this.store.mutate((draft) => {
      draft.bindings = draft.bindings.filter((entry) => entry.windowId !== input.windowId)
      draft.bindings.push(binding)
    })
    context.assertAlive()
    return { bound: true, duplicates, binding }
  }

  private async unbind(context: DispatchContext): Promise<unknown> {
    const input = parseOrThrow(WindowIdInputSchema, context.payload)
    return await this.detachWindow(input, context.assertAlive)
  }

  async detachWindow(
    input: WindowDetachInput,
    assertAlive: () => void = () => undefined,
  ): Promise<WindowDetachResult> {
    assertAlive()
    const unbound = await this.store.mutate((document) => {
      assertAlive()
      const before = document.bindings.length
      document.bindings = document.bindings.filter(
        (entry) => entry.windowId !== input.windowId,
      )
      return before !== document.bindings.length
    })
    assertAlive()
    return { windowId: input.windowId, unbound }
  }

  private async listBindings(context: DispatchContext): Promise<unknown> {
    const document = await this.store.read()
    context.assertAlive()
    const byId = new Map(document.accounts.map((entry) => [entry.id, entry]))
    const items: AccountBindingView[] = document.bindings.map((binding) => {
      const account = byId.get(binding.accountId)
      return {
        ...binding,
        account:
          account === undefined
            ? null
            : {
                id: account.id,
                account: account.account,
                loginMethod: account.loginMethod,
                status: account.status,
                note: account.note,
              },
      }
    })
    return { items }
  }
}
