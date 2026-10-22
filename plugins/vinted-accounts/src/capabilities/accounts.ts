import { randomUUID } from 'node:crypto'

import { invalidRequest, unavailable } from '../domain/errors.js'
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
import type { DispatchContext } from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import type { AccountStore } from '../store/account-store.js'

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
] as const

/** One JSON document holds everything, so growth must stay bounded. */
export const MAX_ACCOUNTS = 2000
/** A broken export can produce a thousand identical errors; show the first few. */
export const MAX_IMPORT_ERRORS = 50

const CSV_MIME = 'text/csv;charset=utf-8'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** A mailbox page is small; anything larger is a misconfigured link. */
const MAX_OTP_BODY = 512 * 1024
const OTP_TIMEOUT_MS = 20_000

export interface AccountPoolOptions {
  store: AccountStore
  logger: Logger
  now?: () => Date
  idFactory?: () => string
  /** Injected so a test can answer an inbox link without a network. */
  fetchImpl?: typeof fetch
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
export class AccountPool {
  readonly id = 'account.pool'
  readonly name = 'Vinted 账号池'

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
  }

  status(): Record<string, unknown> {
    return {
      storage: this.store.kind,
      storageDurable: this.store.durable,
    }
  }

  async call(context: DispatchContext): Promise<unknown> {
    switch (context.method) {
      case 'vinted.accounts.list':
        return await this.listAccounts(context)
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
      case 'vinted.accounts.bindings':
        return await this.listBindings(context)
      default:
        throw invalidRequest('插件不支持该方法')
    }
  }

  private async listAccounts(context: DispatchContext): Promise<unknown> {
    const document = await this.store.read()
    context.assertAlive()
    return {
      items: document.accounts,
      total: document.accounts.length,
      bindings: document.bindings,
      storageDurable: this.store.durable,
    }
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
    const code = extractOtp(body, response.headers.get('content-type') ?? '')
    if (code === null) throw invalidRequest('在取码链接的响应里没有找到验证码')
    // The code itself is deliberately left out of the log line.
    this.logger.info('已读取验证码', { accountId: account.id, channel: input.channel })
    return { channel: input.channel, code, fetchedAt: this.now().toISOString() }
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
    const unbound = await this.store.mutate((document) => {
      const before = document.bindings.length
      document.bindings = document.bindings.filter(
        (entry) => entry.windowId !== input.windowId,
      )
      return before !== document.bindings.length
    })
    context.assertAlive()
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
