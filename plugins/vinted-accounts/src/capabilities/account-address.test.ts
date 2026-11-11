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

const profile = {
  id: 'profile-paris',
  street: 'Rue Exemple',
  houseNumber: '12',
  city: 'Paris',
  postalCode: '75001',
  countryCode: 'FR',
  state: null,
  county: null,
  latitude: 48.8566,
  longitude: 2.3522,
  source: 'osm',
  sourceUrl: 'https://www.openstreetmap.org/node/123',
  approximate: false,
  firstName: 'Marie',
  lastName: 'Exemple',
  username: 'marie.exemple',
}
const linkedAt = '2026-11-11T10:00:00.000Z'
const assigned = { ...profile, linkedAt }
const input: AccountInput = {
  loginMethod: 'email',
  account: 'address@example.test',
  password: '  synthetic password  ',
  phone: '+33123456789',
  emailOtpUrl: 'https://example.test/email',
  smsOtpUrl: 'https://example.test/sms',
  note: 'main seller',
  status: 'active',
  homepageUrl: '',
}
const directories: string[] = []

afterEach(async () => {
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

function fixture(store = createMemoryStore()) {
  let id = 0
  let currentTime = linkedAt
  const pool = new AccountPool({
    store,
    now: () => new Date(currentTime),
    idFactory: () => `account-${++id}`,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  })
  const call = <T = unknown>(method: string, payload: unknown = {}) =>
    pool.call(context(method, payload)) as Promise<T>
  const save = (fields: Partial<AccountInput> = {}) =>
    call<{ item: AccountRecord }>('vinted.accounts.save', { ...input, ...fields })
  const set = (accountId: string, value: unknown, expectedProfileId?: string | null) =>
    call('vinted.accounts.address.set', {
      accountId,
      profile: value,
      ...(expectedProfileId === undefined ? {} : { expectedProfileId }),
    })
  return {
    pool,
    store,
    call,
    save,
    set,
    setTime: (iso: string) => {
      currentTime = iso
    },
  }
}

describe('account address snapshots', () => {
  it('advertises both methods and creates accounts without an address', async () => {
    expect(ACCOUNT_METHODS).toEqual(
      expect.arrayContaining([
        'vinted.accounts.address.targets',
        'vinted.accounts.address.set',
      ]),
    )
    const { save } = fixture()
    expect((await save()).item).toHaveProperty('address', null)
  })

  it('persists a complete independent snapshot and reopens it without an address plugin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-account-address-'))
    directories.push(directory)
    const { save, set, store } = fixture(createFileStore(directory))
    const { item } = await save()
    const source = structuredClone(profile)
    expect(await set(item.id, source, null)).toEqual({
      address: assigned,
      updatedAt: linkedAt,
      storageDurable: true,
    })
    source.city = 'changed after assignment'
    expect((await createFileStore(directory).read()).accounts[0]).toEqual({
      ...item,
      address: assigned,
    })
    expect((await store.read()).accounts[0]?.password).toBe(input.password)
  })

  it('keeps an assigned snapshot through ordinary edits and CSV upserts', async () => {
    const { save, set, call, store } = fixture()
    const { item } = await save()
    await set(item.id, profile)
    await save({ id: item.id, phone: '+33999999999', password: 'new password' })
    expect((await store.read()).accounts[0]).toMatchObject({
      address: assigned,
      phone: '+33999999999',
      password: 'new password',
    })
    await call('vinted.accounts.import', {
      filename: 'accounts.csv',
      text: 'loginMethod,account,password\nemail,address@example.test,imported\nemail,new@example.test,new\n',
    })
    expect(
      (await store.read()).accounts.find((entry) => entry.id === item.id),
    ).toMatchObject({
      address: assigned,
      password: 'imported',
    })
    expect(
      (await store.read()).accounts.find((entry) => entry.account === 'new@example.test'),
    ).toHaveProperty('address', null)
  })

  it.each(['save-first', 'address-first'])(
    'keeps concurrent credential edits and the address patch (%s)',
    async (order) => {
      const { save, set, store } = fixture()
      const { item } = await save()
      const edit = () =>
        save({ id: item.id, password: 'rotated', note: 'edited', status: 'limited' })
      await Promise.all(
        order === 'save-first'
          ? [edit(), set(item.id, profile, null)]
          : [set(item.id, profile, null), edit()],
      )
      expect((await store.read()).accounts[0]).toMatchObject({
        address: assigned,
        password: 'rotated',
        note: 'edited',
        status: 'limited',
        phone: input.phone,
      })
    },
  )

  it('checks the latest address inside the write queue and rejects stale changes or deleted accounts', async () => {
    const { save, set, call, store } = fixture()
    const { item } = await save()
    const outcomes = await Promise.allSettled([
      set(item.id, profile, null),
      set(item.id, { ...profile, id: 'competing-profile' }, null),
    ])
    expect(outcomes.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((outcomes[1] as PromiseRejectedResult).reason).toMatchObject({
      code: 'INVALID_REQUEST',
    })
    const before = await store.read()
    await expect(set(item.id, null, 'stale-profile')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(await store.read()).toEqual(before)
    expect(await set(item.id, null, profile.id)).toEqual({
      address: null,
      updatedAt: linkedAt,
      storageDurable: false,
    })
    await call('vinted.accounts.remove', { accountId: item.id })
    await expect(set(item.id, profile, null)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect((await store.read()).accounts).toEqual([])
  })

  it('replaces the current snapshot only when its expected profile ID matches', async () => {
    const { save, set, store, setTime } = fixture()
    const { item } = await save()
    await set(item.id, profile, null)
    const nextTime = '2026-11-12T10:00:00.000Z'
    const replacement = {
      ...profile,
      id: 'replacement',
      city: 'Lyon',
      postalCode: '69001',
    }
    setTime(nextTime)
    expect(await set(item.id, replacement, profile.id)).toEqual({
      address: { ...replacement, linkedAt: nextTime },
      updatedAt: nextTime,
      storageDurable: false,
    })
    const before = await store.read()
    for (const expected of [null, profile.id]) {
      await expect(set(item.id, null, expected)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      })
      await expect(set(item.id, profile, expected)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      })
    }
    expect(await store.read()).toEqual(before)
    expect(before.accounts[0]).toEqual({
      ...item,
      address: { ...replacement, linkedAt: nextTime },
      updatedAt: nextTime,
    })
  })

  it('refuses to resurrect a target deleted ahead of an address mutation', async () => {
    const { save, set, call, store } = fixture()
    const { item } = await save()
    const removed = call('vinted.accounts.remove', { accountId: item.id })
    const assigned = set(item.id, profile, null)
    await removed
    await expect(assigned).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect((await store.read()).accounts).toEqual([])
  })

  it.each([
    { street: '' },
    { houseNumber: 'x'.repeat(33) },
    { city: 'x'.repeat(121) },
    { postalCode: 'x'.repeat(17) },
    { countryCode: 'CA' },
    { state: 'x'.repeat(121) },
    { latitude: 91 },
    { longitude: -181 },
    { source: 'invented' },
    { sourceUrl: 'x'.repeat(2049) },
    { approximate: 'false' },
    { firstName: '' },
    { lastName: 'x'.repeat(81) },
    { username: '../bad' },
    { id: 'x'.repeat(65) },
    { linkedAt },
    { unknown: 'field' },
  ])('rejects invalid or unknown profile fields: %j', async (patch) => {
    const { save, set, store } = fixture()
    const { item } = await save()
    const before = await store.read()
    await expect(set(item.id, { ...profile, ...patch })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(await store.read()).toEqual(before)
  })

  it.each([
    {},
    { accountId: '', profile },
    { accountId: 'missing', profile },
    { accountId: 'account-1', profile, expectedProfileId: 1 },
    { accountId: 'account-1', profile, password: 'must not be accepted' },
  ])('rejects invalid address targets and patch schemas: %j', async (payload) => {
    const { save, call, store } = fixture()
    await save()
    const before = await store.read()
    await expect(call('vinted.accounts.address.set', payload)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(await store.read()).toEqual(before)
  })

  it('checks request liveness after waiting for the store writer', async () => {
    const { pool, save, store } = fixture()
    const { item } = await save()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const blocker = store.mutate(async () => {
      await barrier
    })
    let alive = true
    const request = context('vinted.accounts.address.set', {
      accountId: item.id,
      profile,
    })
    request.assertAlive = () => {
      if (!alive) throw cancelled()
    }
    const patch = pool.call(request)
    alive = false
    release()
    await blocker
    await expect(patch).rejects.toMatchObject({ code: 'CANCELLED' })
    expect((await store.read()).accounts[0]).toEqual(item)
  })

  it('leaves the previous snapshot and timestamp intact when persistence fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-account-address-failure-'))
    directories.push(directory)
    const { save, set, store, setTime } = fixture(createFileStore(directory))
    const { item } = await save()
    await set(item.id, profile)
    const before = await store.read()
    setTime('2026-11-12T10:00:00.000Z')
    await mkdir(join(directory, 'vinted-accounts.json.tmp'))
    await expect(set(item.id, null, profile.id)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    await expect(
      set(item.id, { ...profile, id: 'failed-replacement' }, profile.id),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await store.read()).toEqual(before)
    expect(await createFileStore(directory).read()).toEqual(before)
    await rm(join(directory, 'vinted-accounts.json.tmp'), { recursive: true })
    expect(await set(item.id, null, profile.id)).toEqual({
      address: null,
      updatedAt: '2026-11-12T10:00:00.000Z',
      storageDurable: true,
    })
    expect((await createFileStore(directory).read()).accounts[0]).toMatchObject({
      address: null,
      updatedAt: '2026-11-12T10:00:00.000Z',
    })
  })

  it('rejects malformed persisted address data while accepting accounts with no address field', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-account-address-schema-'))
    directories.push(directory)
    const document = emptyDocument()
    document.accounts.push({
      ...input,
      id: 'legacy',
      createdAt: linkedAt,
      updatedAt: linkedAt,
    })
    const file = join(directory, 'vinted-accounts.json')
    await writeFile(file, JSON.stringify(document))
    expect((await createFileStore(directory).read()).accounts[0]?.id).toBe('legacy')
    await writeFile(
      file,
      JSON.stringify({
        ...document,
        accounts: [{ ...document.accounts[0], address: { ...assigned, latitude: 91 } }],
      }),
    )
    await expect(createFileStore(directory).read()).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
  })
})

describe('credential-free account address targets', () => {
  it('filters before pagination and only returns the address target fields', async () => {
    const { save, set, call } = fixture()
    for (let index = 0; index < 23; index += 1) {
      await save({
        account: `seller-${index}@example.test`,
        note: index < 21 ? 'shared note' : 'other',
      })
    }
    await set('account-1', profile)
    const page = await call<{
      items: unknown[]
      total: number
      page: number
      pageSize: number
    }>('vinted.accounts.address.targets', { query: 'SHARED NOTE', page: 2, pageSize: 20 })
    expect(page).toMatchObject({
      total: 21,
      page: 2,
      pageSize: 20,
      storageDurable: false,
    })
    expect(page.items).toEqual([
      {
        id: 'account-1',
        account: 'seller-0@example.test',
        status: 'active',
        address: assigned,
      },
    ])
    const defaults = await call<{ items: unknown[] }>('vinted.accounts.address.targets')
    expect(defaults).toMatchObject({ total: 23, page: 1, pageSize: 20 })
    expect(defaults.items).toHaveLength(20)
    expect(JSON.stringify(defaults)).not.toMatch(
      /password|OtpUrl|phone|homepageUrl|synthetic/,
    )
    for (const query of ['paris', 'rue exemple', 'seller-0@']) {
      expect(await call('vinted.accounts.address.targets', { query })).toMatchObject({
        total: 1,
        items: [{ id: 'account-1', address: assigned }],
      })
    }
    expect(await call('vinted.accounts.address.targets', { page: 100 })).toMatchObject({
      items: [],
      total: 23,
    })
  })

  it.each([
    null,
    { page: 0 },
    { page: 1.5 },
    { pageSize: 51 },
    { pageSize: 0 },
    { query: 'x'.repeat(201) },
    { unknown: true },
  ])('rejects invalid or unbounded list inputs: %j', async (payload) => {
    await expect(
      fixture().call('vinted.accounts.address.targets', payload),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('returns null for older records without an address and reports durable storage', async () => {
    const memory = fixture()
    const { item } = await memory.save()
    delete item.address
    const store: AccountStore = {
      kind: 'file',
      durable: true,
      read: async () => ({ ...emptyDocument(), accounts: [item] }),
      mutate: memory.store.mutate.bind(memory.store),
    }
    expect(await fixture(store).call('vinted.accounts.address.targets')).toEqual({
      items: [{ id: item.id, account: input.account, status: 'active', address: null }],
      total: 1,
      page: 1,
      pageSize: 20,
      storageDurable: true,
    })
  })
})
