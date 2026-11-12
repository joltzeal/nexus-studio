import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { cancelled } from '../domain/errors.js'
import type { AccountInput, AccountRecord } from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import {
  createFileStore,
  createMemoryStore,
  emptyDocument,
  type AccountStore,
} from '../store/account-store.js'
import { ACCOUNT_METHODS, AccountPool } from './accounts.js'

const linkedAt = '2026-11-12T10:00:00.000Z'
const later = '2026-11-12T11:00:00.000Z'
const mailbox = {
  pluginId: 'studio.email',
  mailboxId: 'mailbox-original',
  email: 'mailbox@example.test',
}
const assigned = { ...mailbox, linkedAt }
const input: AccountInput = {
  loginMethod: 'email',
  account: 'seller@example.test',
  password: '  synthetic account password  ',
  phone: '+33123456789',
  emailOtpUrl: 'https://example.test/email?token=synthetic-email-token',
  smsOtpUrl: 'https://example.test/sms?token=synthetic-sms-token',
  note: 'seller note',
  status: 'active',
  homepageUrl: '',
}
const directories: string[] = []
const pools: AccountPool[] = []

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.orders.stop()))
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function context(method: string, payload: unknown = {}): DispatchContext {
  return {
    requestId: method,
    capability: 'account.pool',
    method,
    payload,
    deadlineAt: Date.now() + 10_000,
    assertAlive: () => undefined,
  }
}

function fixture(store: AccountStore = createMemoryStore()) {
  let nextId = 0
  let time = linkedAt
  const pool = new AccountPool({
    store,
    now: () => new Date(time),
    idFactory: () => `account-${++nextId}`,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    orderSourceFactory: () => ({
      scan: async () => [],
      check: async () => ({ sold: false, error: null }),
    }),
  })
  pools.push(pool)
  const call = <T = unknown>(method: string, payload: unknown = {}) =>
    pool.call(context(method, payload)) as Promise<T>
  const save = (fields: Partial<AccountInput> = {}) =>
    call<{ item: AccountRecord }>('vinted.accounts.save', { ...input, ...fields })
  const set = (accountId: string, value: unknown, expectedMailboxId: string | null) =>
    call('vinted.accounts.mailbox.set', {
      accountId,
      mailbox: value,
      expectedMailboxId,
    })
  return {
    pool,
    store,
    call,
    save,
    set,
    setTime: (value: string) => {
      time = value
    },
  }
}

async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'nexus-account-mailbox-'))
  directories.push(value)
  return value
}

describe('durable account mailbox relations', () => {
  it('advertises both methods and creates an explicitly unlinked account', async () => {
    expect(ACCOUNT_METHODS).toEqual(
      expect.arrayContaining([
        'vinted.accounts.mailbox.targets',
        'vinted.accounts.mailbox.set',
      ]),
    )
    expect((await fixture().save()).item).toHaveProperty('mailbox', null)
  })

  it('persists the relation independently and only updates mailbox and updatedAt', async () => {
    const path = await directory()
    const t = fixture(createFileStore(path))
    const { item } = await t.save()
    t.setTime(later)
    const source = { ...mailbox }
    expect(await t.set(item.id, source, null)).toEqual({
      mailbox: { ...mailbox, linkedAt: later },
      updatedAt: later,
      storageDurable: true,
    })
    source.email = 'changed@example.test'
    expect((await createFileStore(path).read()).accounts[0]).toEqual({
      ...item,
      mailbox: { ...mailbox, linkedAt: later },
      updatedAt: later,
    })
  })

  it('replaces and unlinks only the mailbox ID observed by the caller', async () => {
    const t = fixture()
    const { item } = await t.save()
    await t.set(item.id, mailbox, null)
    t.setTime(later)
    const replacement = {
      ...mailbox,
      mailboxId: 'replacement',
      email: 'other@example.test',
    }
    expect(await t.set(item.id, replacement, mailbox.mailboxId)).toEqual({
      mailbox: { ...replacement, linkedAt: later },
      updatedAt: later,
      storageDurable: false,
    })
    const before = await t.store.read()
    for (const expected of [null, mailbox.mailboxId]) {
      await expect(t.set(item.id, mailbox, expected)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      })
      await expect(t.set(item.id, null, expected)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      })
    }
    expect(await t.store.read()).toEqual(before)
    expect(await t.set(item.id, null, replacement.mailboxId)).toEqual({
      mailbox: null,
      updatedAt: later,
      storageDurable: false,
    })
  })

  it.each(['memory', 'file'])(
    'serializes competing assignments so a stale CAS cannot overwrite the first (%s)',
    async (kind) => {
      const path = kind === 'file' ? await directory() : null
      const t = fixture(path === null ? createMemoryStore() : createFileStore(path))
      const { item } = await t.save()
      const outcomes = await Promise.allSettled([
        t.set(item.id, mailbox, null),
        t.set(item.id, { ...mailbox, mailboxId: 'competitor' }, null),
      ])
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected'])
      expect((outcomes[1] as PromiseRejectedResult).reason).toMatchObject({
        code: 'INVALID_REQUEST',
      })
      const stored =
        path === null ? await t.store.read() : await createFileStore(path).read()
      expect(stored.accounts[0]).toEqual({ ...item, mailbox: assigned })
    },
  )

  it.each(['edit-first', 'link-first'])(
    'preserves concurrent credential and contact edits (%s)',
    async (order) => {
      const t = fixture()
      const { item } = await t.save()
      const edit = () =>
        t.save({
          id: item.id,
          account: 'renamed-seller@example.test',
          password: 'synthetic replacement',
          phone: '+33999999999',
          smsOtpUrl: '',
          note: 'changed note',
          status: 'limited',
        })
      await Promise.all(
        order === 'edit-first'
          ? [edit(), t.set(item.id, mailbox, null)]
          : [t.set(item.id, mailbox, null), edit()],
      )
      expect((await t.store.read()).accounts[0]).toMatchObject({
        mailbox: assigned,
        account: 'renamed-seller@example.test',
        password: 'synthetic replacement',
        phone: '+33999999999',
        smsOtpUrl: '',
        emailOtpUrl: input.emailOtpUrl,
        note: 'changed note',
        status: 'limited',
      })
    },
  )

  it('keeps the relation through CSV upserts, contact clearing, bindings and order updates', async () => {
    const t = fixture()
    const { item } = await t.save()
    await t.set(item.id, mailbox, null)
    await t.call('vinted.accounts.bind', { accountId: item.id, windowId: 'window-1' })
    await t.call('vinted.accounts.import', {
      filename: 'accounts.csv',
      text: 'loginMethod,account,password\nemail,seller@example.test,imported\nemail,new@example.test,new\n',
    })
    expect(
      (await t.store.read()).accounts.find((entry) => entry.id !== item.id),
    ).toHaveProperty('mailbox', null)
    await t.save({
      id: item.id,
      phone: '',
      smsOtpUrl: '',
      homepageUrl: 'https://www.vinted.fr/member/123-seller',
    })
    await t.call('vinted.accounts.orders.settings.save', {
      intervalMinutes: 15,
      bark: { enabled: false, baseUrl: 'https://api.day.app', deviceKey: '' },
    })
    await Promise.all([
      t.pool.orders.tick(),
      t.set(item.id, { ...mailbox, mailboxId: 'new-mailbox' }, mailbox.mailboxId),
    ])
    await t.call('vinted.accounts.orders.enabled', { accountId: item.id, enabled: false })
    const stored = await t.store.read()
    expect(stored.accounts.find((entry) => entry.id === item.id)).toMatchObject({
      mailbox: { ...assigned, mailboxId: 'new-mailbox' },
      account: input.account,
      phone: '',
      smsOtpUrl: '',
    })
    expect(stored.bindings).toEqual([
      { accountId: item.id, windowId: 'window-1', boundAt: linkedAt },
    ])
    expect(stored.orderWatch.records[0]).toMatchObject({
      accountId: item.id,
      enabled: false,
      lastCompleteAt: linkedAt,
    })
  })

  it('rejects missing accounts and a relation patch queued after account deletion', async () => {
    const t = fixture()
    const { item } = await t.save()
    await expect(t.set('missing-account', mailbox, null)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    const outcomes = await Promise.allSettled([
      t.call('vinted.accounts.remove', { accountId: item.id }),
      t.set(item.id, mailbox, null),
    ])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected'])
    expect((outcomes[1] as PromiseRejectedResult).reason).toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect((await t.store.read()).accounts).toEqual([])
  })

  it('does not apply a cancelled request after waiting for the writer', async () => {
    const t = fixture()
    const { item } = await t.save()
    let release!: () => void
    const blocker = t.store.mutate(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const request = context('vinted.accounts.mailbox.set', {
      accountId: item.id,
      mailbox,
      expectedMailboxId: null,
    })
    let alive = true
    request.assertAlive = () => {
      if (!alive) throw cancelled()
    }
    const patch = t.pool.call(request)
    alive = false
    await Promise.resolve()
    release()
    await blocker
    await expect(patch).rejects.toMatchObject({ code: 'CANCELLED' })
    expect((await t.store.read()).accounts[0]).toEqual(item)
  })

  it('keeps memory and disk unchanged after a real persistence failure and allows retry', async () => {
    const path = await directory()
    const t = fixture(createFileStore(path))
    const { item } = await t.save()
    await t.set(item.id, mailbox, null)
    const before = await t.store.read()
    t.setTime(later)
    const temporary = join(path, 'vinted-accounts.json.tmp')
    await mkdir(temporary)
    for (const value of [null, { ...mailbox, mailboxId: 'replacement' }]) {
      await expect(t.set(item.id, value, mailbox.mailboxId)).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      })
    }
    expect(await t.store.read()).toEqual(before)
    expect(await createFileStore(path).read()).toEqual(before)
    await rm(temporary, { recursive: true })
    await t.set(item.id, null, mailbox.mailboxId)
    expect((await createFileStore(path).read()).accounts[0]).toEqual({
      ...item,
      mailbox: null,
      updatedAt: later,
    })
  })

  it.each([
    {},
    { pluginId: 'another.plugin' },
    { mailboxId: '' },
    { mailboxId: ' padded ' },
    { mailboxId: 'x'.repeat(65) },
    { email: 'not-email' },
    { email: `${'a'.repeat(250)}@example.test` },
    { linkedAt },
    { password: 'synthetic password' },
    { refreshToken: 'synthetic token' },
  ])('rejects invalid or credential-bearing mailbox inputs: %j', async (patch) => {
    const t = fixture()
    const { item } = await t.save()
    const before = await t.store.read()
    const value = Object.keys(patch).length === 0 ? {} : { ...mailbox, ...patch }
    await expect(t.set(item.id, value, null)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(await t.store.read()).toEqual(before)
  })

  it.each([
    { accountId: 'account-1', mailbox },
    { accountId: '', mailbox, expectedMailboxId: null },
    { accountId: 'account-1', mailbox, expectedMailboxId: 1 },
    { accountId: 'account-1', mailbox, expectedMailboxId: '' },
    { accountId: 'account-1', mailbox, expectedMailboxId: null, password: 'synthetic' },
  ])(
    'requires an explicit valid expected ID and a strict relation-only patch: %j',
    async (payload) => {
      const t = fixture()
      await t.save()
      const before = await t.store.read()
      await expect(t.call('vinted.accounts.mailbox.set', payload)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      })
      expect(await t.store.read()).toEqual(before)
    },
  )

  it('accepts older records without a relation and rejects malformed persisted relations', async () => {
    const path = await directory()
    const document = emptyDocument()
    const account = {
      ...input,
      id: 'older-account',
      createdAt: linkedAt,
      updatedAt: linkedAt,
    }
    document.accounts.push(account)
    const file = join(path, 'vinted-accounts.json')
    await writeFile(file, JSON.stringify(document))
    const t = fixture(createFileStore(path))
    expect(await t.call('vinted.accounts.mailbox.targets')).toMatchObject({
      items: [{ id: account.id, mailbox: null }],
      storageDurable: true,
    })
    await t.set(account.id, mailbox, null)
    expect((await createFileStore(path).read()).accounts[0]).toMatchObject({
      mailbox: assigned,
    })
    for (const bad of [
      { ...assigned, linkedAt: 'invalid' },
      { ...assigned, password: 'synthetic' },
    ]) {
      await writeFile(
        file,
        JSON.stringify({ ...document, accounts: [{ ...account, mailbox: bad }] }),
      )
      await expect(createFileStore(path).read()).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      })
    }
  })
})

describe('credential-free account mailbox targets', () => {
  it('searches account and linked mailbox emails before paging without exposing credentials', async () => {
    const t = fixture()
    for (let index = 0; index < 23; index += 1) {
      await t.save({ account: `seller-${index}@example.test` })
    }
    await t.set('account-1', mailbox, null)
    const page = await t.call<{ items: unknown[] }>('vinted.accounts.mailbox.targets', {
      query: 'EXAMPLE.TEST',
      page: 2,
      pageSize: 20,
    })
    expect(page).toEqual({
      items: [
        {
          id: 'account-3',
          account: 'seller-2@example.test',
          status: 'active',
          mailbox: null,
        },
        {
          id: 'account-2',
          account: 'seller-1@example.test',
          status: 'active',
          mailbox: null,
        },
        {
          id: 'account-1',
          account: 'seller-0@example.test',
          status: 'active',
          mailbox: assigned,
        },
      ],
      total: 23,
      page: 2,
      pageSize: 20,
      storageDurable: false,
    })
    await t.save({ account: mailbox.email })
    expect(
      await t.call('vinted.accounts.mailbox.targets', { query: 'MAILBOX@EXAMPLE.TEST' }),
    ).toMatchObject({
      items: [
        { id: 'account-24', account: mailbox.email, mailbox: null },
        { id: 'account-1', account: 'seller-0@example.test', mailbox: assigned },
      ],
      total: 2,
    })
    const defaults = await t.call<{ items: unknown[] }>('vinted.accounts.mailbox.targets')
    expect(defaults).toMatchObject({ total: 24, page: 1, pageSize: 20 })
    expect(defaults.items).toHaveLength(20)
    expect(JSON.stringify(page)).not.toMatch(
      /password|phone|OtpUrl|token|note|homepageUrl/,
    )
    expect(await t.call('vinted.accounts.mailbox.targets', { page: 100 })).toMatchObject({
      items: [],
      total: 24,
      page: 100,
    })
  })

  it.each([
    null,
    { page: 0 },
    { page: 1.5 },
    { page: Number.MAX_SAFE_INTEGER + 1 },
    { pageSize: 0 },
    { pageSize: 51 },
    { query: 'x'.repeat(201) },
    { password: 'synthetic' },
  ])('rejects invalid query and pagination parameters: %j', async (payload) => {
    await expect(
      fixture().call('vinted.accounts.mailbox.targets', payload),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })
})

describe('device-local mailbox relations in portable transfers', () => {
  it('clears links on the wire and in imported copies while preserving source and existing local links', async () => {
    const source = fixture()
    const { item } = await source.save()
    await source.set(item.id, mailbox, null)
    await source.call('vinted.accounts.bind', {
      accountId: item.id,
      windowId: 'source-window',
    })
    const data = await source.call<{
      accounts: Record<string, unknown>[]
      bindings: unknown[]
    }>('transfer.export', { windowIds: ['source-window'], endpointIds: [] })
    expect(data.accounts[0]).toHaveProperty('mailbox', null)
    expect(JSON.stringify(data)).not.toContain(mailbox.mailboxId)
    expect((await source.store.read()).accounts[0]).toMatchObject({ mailbox: assigned })

    const path = await directory()
    const target = fixture(createFileStore(path))
    const local = (await target.save()).item
    await target.set(local.id, { ...mailbox, mailboxId: 'local-mailbox' }, null)
    // A valid older attachment may still carry a source device's relation.
    data.accounts[0]!.mailbox = assigned
    await target.call('transfer.import', {
      data,
      windowIdMap: { 'source-window': 'new-window' },
    })
    const stored = await createFileStore(path).read()
    const copy = stored.accounts.find((entry) => entry.id !== local.id)!
    expect(copy).toMatchObject({
      mailbox: null,
      password: input.password,
      account: input.account,
    })
    expect(stored.accounts.find((entry) => entry.id === local.id)).toMatchObject({
      mailbox: { ...assigned, mailboxId: 'local-mailbox' },
    })
    expect(stored.bindings).toEqual([
      { windowId: 'new-window', accountId: copy.id, boundAt: linkedAt },
    ])
  })
})
