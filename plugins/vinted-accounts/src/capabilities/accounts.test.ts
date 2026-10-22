import { describe, expect, it } from 'vitest'

import { buildXlsx } from '../domain/table.js'
import type { DispatchContext } from '../rpc/protocol.js'
import type { Logger } from '../rpc/redact.js'
import { createMemoryStore } from '../store/account-store.js'
import type {
  AccountInput,
  AccountRecord,
  BindingRecord,
  ImportReport,
  TemplateFile,
} from '../domain/types.js'
import { AccountPool } from './accounts.js'

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

interface Fixture {
  pool: AccountPool
  clock: { now: Date }
}

function fixture(): Fixture {
  const store = createMemoryStore()
  const clock = { now: new Date('2026-10-22T10:00:00.000Z') }
  let counter = 0
  const pool = new AccountPool({
    store,
    logger,
    now: () => clock.now,
    idFactory: () => {
      counter += 1
      return `id-${String(counter)}`
    },
  })
  return { pool, clock }
}

function context(method: string, payload: unknown = {}): DispatchContext {
  return {
    requestId: `req-${method}`,
    capability: 'account.pool',
    method,
    payload,
    deadlineAt: Date.now() + 1000,
    assertAlive: () => undefined,
  }
}

async function call<T>(
  pool: AccountPool,
  method: string,
  payload: unknown = {},
): Promise<T> {
  return (await pool.call(context(method, payload))) as T
}

function account(overrides: Partial<AccountInput> = {}): AccountInput {
  return {
    loginMethod: 'email',
    account: 'a@b.com',
    password: 'secret',
    phone: '',
    emailOtpUrl: '',
    smsOtpUrl: '',
    note: '',
    status: 'active',
    homepageUrl: '',
    ...overrides,
  }
}

interface AccountList {
  items: AccountRecord[]
  total: number
  bindings: BindingRecord[]
}

const CSV_HEADER =
  '登录方式,账号,密码,手机号,邮箱接码地址,手机接码地址,账号状态,主页链接,备注'

describe('account records', () => {
  it('saves an account with only the required fields filled in', async () => {
    const { pool } = fixture()
    const saved = await call<{ item: AccountRecord; created: boolean }>(
      pool,
      'vinted.accounts.save',
      account({ phone: '13800000000', note: '主号' }),
    )
    expect(saved.created).toBe(true)
    expect(saved.item).toMatchObject({
      id: 'id-1',
      loginMethod: 'email',
      account: 'a@b.com',
      password: 'secret',
      phone: '13800000000',
      status: 'active',
      createdAt: '2026-10-22T10:00:00.000Z',
    })
    const list = await call<AccountList>(pool, 'vinted.accounts.list')
    expect(list.total).toBe(1)
    expect(list.bindings).toEqual([])
  })

  it('refuses a second account with the same login', async () => {
    const { pool } = fixture()
    await call(pool, 'vinted.accounts.save', account())
    await expect(
      call(pool, 'vinted.accounts.save', account({ account: 'A@B.com' })),
    ).rejects.toThrow('已存在')
  })

  it('editing keeps the id and the creation time', async () => {
    const { pool, clock } = fixture()
    const saved = await call<{ item: AccountRecord }>(
      pool,
      'vinted.accounts.save',
      account(),
    )
    clock.now = new Date('2026-10-23T08:00:00.000Z')
    const updated = await call<{ item: AccountRecord; created: boolean }>(
      pool,
      'vinted.accounts.save',
      account({
        id: saved.item.id,
        password: 'rotated',
        status: 'limited',
        homepageUrl: 'vinted.fr/member/9',
      }),
    )
    expect(updated.created).toBe(false)
    expect(updated.item.id).toBe('id-1')
    expect(updated.item.createdAt).toBe('2026-10-22T10:00:00.000Z')
    expect(updated.item.updatedAt).toBe('2026-10-23T08:00:00.000Z')
    expect(updated.item.password).toBe('rotated')
    expect(updated.item.status).toBe('limited')
    // A bare host is completed, not rejected.
    expect(updated.item.homepageUrl).toBe('https://vinted.fr/member/9')
  })

  it('removing an account drops the windows it was bound to', async () => {
    const { pool } = fixture()
    const saved = await call<{ item: AccountRecord }>(
      pool,
      'vinted.accounts.save',
      account(),
    )
    await call(pool, 'vinted.accounts.bind', {
      accountId: saved.item.id,
      windowId: 'win-1',
    })
    const removed = await call<{ removed: boolean }>(pool, 'vinted.accounts.remove', {
      accountId: saved.item.id,
    })
    expect(removed.removed).toBe(true)
    const bindings = await call<{ items: unknown[] }>(pool, 'vinted.accounts.bindings')
    expect(bindings.items).toEqual([])
  })
})

describe('import', () => {
  it('reports the rows it could not read instead of dropping them', async () => {
    const { pool } = fixture()
    const text = [
      CSV_HEADER,
      'email,a@b.com,pass1,13800000000,https://mail.example.com/o,https://sms.example.com/o,正常,vinted.fr/member/1,主号',
      ',no-method@b.com,pass2,,,,,,',
      'google,g@c.com,,,,,,,',
    ].join('\n')
    const report = await call<ImportReport>(pool, 'vinted.accounts.import', {
      filename: 'accounts.csv',
      text,
    })
    expect(report).toMatchObject({ total: 3, inserted: 2, updated: 0, skipped: 1 })
    expect(report.errors).toEqual([{ row: 4, message: '密码为空' }])

    const list = await call<AccountList>(pool, 'vinted.accounts.list')
    expect(list.items.map((entry) => entry.account)).toEqual([
      'a@b.com',
      'no-method@b.com',
    ])
    expect(list.items[0]).toMatchObject({
      phone: '13800000000',
      emailOtpUrl: 'https://mail.example.com/o',
      smsOtpUrl: 'https://sms.example.com/o',
      status: 'active',
      homepageUrl: 'https://vinted.fr/member/1',
      note: '主号',
    })
    // A blank login method is inferred from an email-shaped account.
    expect(list.items[1]?.loginMethod).toBe('email')
  })

  it('re-importing the same file updates instead of duplicating', async () => {
    const { pool } = fixture()
    const text = `${CSV_HEADER}\nemail,a@b.com,pass1,,,,,,\n`
    await call(pool, 'vinted.accounts.import', { filename: 'a.csv', text })
    const second = await call<ImportReport>(pool, 'vinted.accounts.import', {
      filename: 'a.csv',
      text: text.replace('pass1', 'pass2'),
    })
    expect(second).toMatchObject({ inserted: 0, updated: 1, skipped: 0 })
    const list = await call<AccountList>(pool, 'vinted.accounts.list')
    expect(list.total).toBe(1)
    expect(list.items[0]?.password).toBe('pass2')
  })

  it('falls back to the template column order when there is no header', async () => {
    const { pool } = fixture()
    const report = await call<ImportReport>(pool, 'vinted.accounts.import', {
      filename: 'a.csv',
      text: 'email,x@y.com,pass,,,,,,\n',
    })
    expect(report.inserted).toBe(1)
    const list = await call<AccountList>(pool, 'vinted.accounts.list')
    expect(list.items[0]).toMatchObject({ account: 'x@y.com', loginMethod: 'email' })
  })

  it('accepts a workbook exported from a spreadsheet app', async () => {
    const { pool } = fixture()
    const rows = [
      ['登录方式', '账号', '密码'],
      ['apple', 'i@cloud.com', 'pw'],
    ]
    const report = await call<ImportReport>(pool, 'vinted.accounts.import', {
      filename: 'accounts.xlsx',
      base64: Buffer.from(buildXlsx(rows)).toString('base64'),
    })
    expect(report).toMatchObject({ inserted: 1, skipped: 0 })
  })

  it('rejects a file it cannot read', async () => {
    const { pool } = fixture()
    await expect(
      call(pool, 'vinted.accounts.import', {
        filename: 'accounts.xlsx',
        base64: Buffer.from('not a workbook').toString('base64'),
      }),
    ).rejects.toThrow(/不是有效的 xlsx/)
  })
})

describe('template', () => {
  it('offers a csv template with the columns the importer reads', async () => {
    const { pool } = fixture()
    const file = await call<TemplateFile>(pool, 'vinted.accounts.template', {
      format: 'csv',
    })
    const text = Buffer.from(file.base64, 'base64').toString('utf8')
    expect(file.filename).toBe('vinted-accounts-template.csv')
    expect(text.startsWith('\uFEFF')).toBe(true)
    const { parseCsv } = await import('../domain/table.js')
    const [header] = parseCsv(text)
    expect(header).toEqual([
      '登录方式',
      '账号',
      '密码',
      '手机号',
      '邮箱接码地址',
      '手机接码地址',
      '账号状态',
      '主页链接',
      '备注',
    ])
  })

  it('offers a workbook template that opens as one sheet', async () => {
    const { pool } = fixture()
    const file = await call<TemplateFile>(pool, 'vinted.accounts.template', {
      format: 'xlsx',
    })
    const { parseXlsx } = await import('../domain/table.js')
    const rows = parseXlsx(Buffer.from(file.base64, 'base64'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.[0]).toBe('登录方式')
  })
})

describe('window bindings', () => {
  it('keeps one account per window and warns about a second window', async () => {
    const { pool } = fixture()
    const first = await call<{ item: AccountRecord }>(
      pool,
      'vinted.accounts.save',
      account(),
    )
    const second = await call<{ item: AccountRecord }>(
      pool,
      'vinted.accounts.save',
      account({ account: 'other@b.com' }),
    )

    const bound = await call<{ bound: boolean; duplicates: string[] }>(
      pool,
      'vinted.accounts.bind',
      { accountId: first.item.id, windowId: 'win-1' },
    )
    expect(bound).toMatchObject({ bound: true, duplicates: [] })

    const duplicate = await call<{ bound: boolean; duplicates: string[] }>(
      pool,
      'vinted.accounts.bind',
      { accountId: first.item.id, windowId: 'win-2' },
    )
    expect(duplicate).toMatchObject({ bound: false, duplicates: ['win-1'] })
    const pending = await call<{ items: BindingRecord[] }>(
      pool,
      'vinted.accounts.bindings',
    )
    expect(pending.items).toHaveLength(1)

    const confirmed = await call<{ bound: boolean }>(pool, 'vinted.accounts.bind', {
      accountId: first.item.id,
      windowId: 'win-2',
      confirmDuplicates: true,
    })
    expect(confirmed.bound).toBe(true)

    // A window holds a single account: binding a different one replaces it.
    await call(pool, 'vinted.accounts.bind', {
      accountId: second.item.id,
      windowId: 'win-1',
    })
    const bindings = await call<{
      items: { windowId: string; account: { account: string } | null }[]
    }>(pool, 'vinted.accounts.bindings')
    expect(bindings.items).toHaveLength(2)
    expect(
      bindings.items.find((entry) => entry.windowId === 'win-1')?.account,
    ).toMatchObject({ account: 'other@b.com' })
  })

  it('unbinds a window', async () => {
    const { pool } = fixture()
    const saved = await call<{ item: AccountRecord }>(
      pool,
      'vinted.accounts.save',
      account(),
    )
    await call(pool, 'vinted.accounts.bind', {
      accountId: saved.item.id,
      windowId: 'win-1',
    })
    const result = await call<{ unbound: boolean }>(pool, 'vinted.accounts.unbind', {
      windowId: 'win-1',
    })
    expect(result.unbound).toBe(true)
    const again = await call<{ unbound: boolean }>(pool, 'vinted.accounts.unbind', {
      windowId: 'win-1',
    })
    expect(again.unbound).toBe(false)
  })

  it('refuses to bind a window to an account that no longer exists', async () => {
    const { pool } = fixture()
    await expect(
      call(pool, 'vinted.accounts.bind', { accountId: 'missing', windowId: 'win-1' }),
    ).rejects.toThrow('账号不存在')
  })
})
