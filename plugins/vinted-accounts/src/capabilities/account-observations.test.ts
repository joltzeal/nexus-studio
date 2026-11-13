import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { cancelled } from '../domain/errors.js'
import type { AccountRecord } from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import {
  createFileStore,
  createMemoryStore,
  type AccountStore,
} from '../store/account-store.js'
import { ACCOUNT_METHODS, AccountPool } from './accounts.js'

const accountId = '11111111-1111-4111-8111-111111111111'
const windowId = '22222222-2222-4222-8222-222222222222'
const operationId = '33333333-3333-4333-8333-333333333333'
const otherOperationId = '44444444-4444-4444-8444-444444444444'
const thirdOperationId = '55555555-5555-4555-8555-555555555555'
const early = '2026-11-13T08:00:00.000Z'
const later = '2026-11-13T09:00:00.000Z'
const now = '2026-11-13T10:00:00.000Z'
const recordMethod = 'vinted.accounts.observations.record'
const snapshotMethod = 'vinted.accounts.agent.snapshot'
const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

function context(method: string, payload: unknown): DispatchContext {
  return {
    requestId: method,
    capability: 'account.pool',
    method,
    payload,
    deadlineAt: Date.now() + 10_000,
    assertAlive: () => undefined,
  }
}

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'nexus-account-observation-'))
  directories.push(path)
  return path
}

function poolFor(store: AccountStore) {
  const pool = new AccountPool({
    store,
    now: () => new Date(now),
    idFactory: () => accountId,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  })
  const call = (method: string, payload: unknown) => pool.call(context(method, payload))
  const record = (fields: Record<string, unknown> = {}) =>
    call(recordMethod, observation(fields))
  return { pool, store, call, record }
}

function observation(fields: Record<string, unknown> = {}) {
  return {
    operationId,
    accountId,
    windowId,
    observedAt: early,
    source: 'official',
    ...fields,
  }
}

async function fixture(store = createMemoryStore()) {
  const f = poolFor(store)
  const saved = (await f.call('vinted.accounts.save', {
    loginMethod: 'email',
    account: 'seller@example.test',
    password: ' synthetic password with spaces ',
    phone: '+33123456789',
    emailOtpUrl: 'https://example.test/email?key=synthetic',
    smsOtpUrl: 'https://example.test/sms?key=synthetic',
    note: 'Keep this operator note.',
    status: 'active',
    homepageUrl: 'https://www.vinted.fr/member/123-seller',
  })) as { item: AccountRecord }
  await store.mutate((document) => {
    document.accounts[0]!.mailbox = {
      pluginId: 'studio.email',
      mailboxId: 'synthetic-mailbox',
      email: 'mailbox@example.test',
      linkedAt: early,
    }
    document.accounts[0]!.address = {
      id: 'synthetic-address',
      street: 'Rue Exemple',
      houseNumber: '12',
      city: 'Paris',
      postalCode: '75001',
      countryCode: 'FR',
      state: null,
      county: null,
      latitude: 48.85,
      longitude: 2.35,
      source: 'osm',
      sourceUrl: 'https://www.openstreetmap.org/node/123',
      approximate: false,
      firstName: 'Example',
      lastName: 'Seller',
      username: 'example.seller',
      linkedAt: early,
    }
    document.accounts[0]!.createdAt = early
    document.accounts[0]!.updatedAt = early
  })
  await f.call('vinted.accounts.bind', { accountId: saved.item.id, windowId })
  return f
}

describe('account observations for the sales Agent', () => {
  it('exposes only bound identity, status, homepage and observation in the Agent snapshot', async () => {
    const f = await fixture()
    const before = await f.store.read()
    expect(ACCOUNT_METHODS).toEqual(
      expect.arrayContaining([recordMethod, snapshotMethod]),
    )
    expect(await f.call(snapshotMethod, { windowId })).toEqual({
      account: {
        accountId,
        account: 'seller@example.test',
        status: 'active',
        homepageUrl: 'https://www.vinted.fr/member/123-seller',
        platformUserId: '123',
        observation: null,
      },
      windowId,
    })
    expect(await f.store.read()).toEqual(before)
  })

  it.each(['memory', 'file'])(
    'preserves omitted fields, credentials and relations (%s)',
    async (kind) => {
      const f = await fixture(
        kind === 'file' ? createFileStore(await directory()) : createMemoryStore(),
      )
      const before = await f.store.read()
      await f.record({
        platformUserId: '123',
        status: 'limited',
        tags: ['verified', 'seller'],
        summary: 'Identity and balance confirmed.',
        rating: 4.8,
        balance: { currency: 'EUR', available: '12.34', pending: '5.00' },
      })
      const next = observation({
        operationId: otherOperationId,
        observedAt: later,
        source: 'page',
        balance: { currency: 'EUR', available: '15.00', pending: null },
      })
      await f.call(recordMethod, next)
      const stored = await f.store.read()
      expect(stored.bindings).toEqual(before.bindings)
      expect(stored.accounts[0]).toMatchObject({
        ...before.accounts[0],
        status: 'limited',
        updatedAt: now,
        observation: {
          platformUserId: '123',
          tags: ['verified', 'seller'],
          summary: 'Identity and balance confirmed.',
          rating: 4.8,
          balance: {
            currency: 'EUR',
            available: '15.00',
            pending: '5.00',
            availableEvidence: { source: 'page', observedAt: later },
            pendingEvidence: { source: 'official', observedAt: early },
          },
          statusEvidence: { status: 'limited', source: 'official', observedAt: early },
          lastObservation: next,
        },
      })
      const listed = (await f.call('vinted.accounts.list', {})) as {
        items: AccountRecord[]
      }
      expect(listed.items).toEqual(stored.accounts)
    },
  )

  it('keeps unknown amounts null, preserves older known amounts and never mixes currencies', async () => {
    const f = await fixture()
    await f.record({
      balance: { currency: 'EUR', available: null, pending: null },
    })
    expect((await f.store.read()).accounts[0]).toMatchObject({
      observation: {
        balance: {
          currency: 'EUR',
          available: null,
          pending: null,
          availableEvidence: null,
          pendingEvidence: null,
        },
      },
    })
    await f.record({
      operationId: otherOperationId,
      observedAt: later,
      balance: { currency: 'EUR', available: '0.00', pending: '19.01' },
    })
    await f.record({
      operationId: thirdOperationId,
      observedAt: now,
      balance: { currency: 'GBP', available: '8.50', pending: null },
    })
    expect((await f.store.read()).accounts[0]).toMatchObject({
      observation: {
        balance: {
          currency: 'GBP',
          available: '8.50',
          pending: null,
          pendingEvidence: null,
        },
      },
    })
  })

  it('retains a known balance and its evidence when a later currency read is entirely unknown', async () => {
    const f = await fixture()
    await f.record({
      balance: { currency: 'EUR', available: '0.00', pending: '12.00' },
    })
    await f.record({
      operationId: otherOperationId,
      observedAt: later,
      balance: { currency: 'GBP', available: null, pending: null },
    })
    expect((await f.store.read()).accounts[0]).toMatchObject({
      observation: {
        balance: {
          currency: 'EUR',
          available: '0.00',
          pending: '12.00',
          availableEvidence: { source: 'official', observedAt: early },
          pendingEvidence: { source: 'official', observedAt: early },
        },
        lastObservation: {
          observedAt: later,
          balance: { currency: 'GBP', available: null, pending: null },
        },
      },
    })
  })

  it('persists identical operation receipts across reopening and rejects conflicting input', async () => {
    const path = await directory()
    const f = await fixture(createFileStore(path))
    const input = observation({ summary: 'First observation.', tags: ['seller'] })
    const receipt = await f.call(recordMethod, input)
    expect(receipt).toEqual({
      operationId,
      accountId,
      applied: true,
      storageDurable: true,
    })
    const reopened = poolFor(createFileStore(path))
    const before = await reopened.store.read()
    expect(
      await reopened.call(
        recordMethod,
        Object.fromEntries(Object.entries(input).reverse()),
      ),
    ).toEqual(receipt)
    for (const change of [
      { summary: 'Changed.' },
      { tags: ['different'] },
      { source: 'page' },
      { observedAt: later },
      { rating: 0 },
    ]) {
      await expect(
        reopened.call(recordMethod, { ...input, ...change }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    expect(await reopened.store.read()).toEqual(before)
  })

  it('preserves official status evidence and per-amount timestamps across reopening', async () => {
    const path = await directory()
    const f = await fixture(createFileStore(path))
    await f.record({
      status: 'blocked',
      balance: { currency: 'EUR', available: '11.25', pending: '9.30' },
    })
    const reopened = poolFor(createFileStore(path))
    await reopened.record({
      operationId: otherOperationId,
      observedAt: later,
      source: 'model',
      status: 'active',
      balance: { currency: 'EUR', available: null, pending: null },
    })
    expect((await createFileStore(path).read()).accounts[0]).toMatchObject({
      status: 'blocked',
      observation: {
        statusEvidence: { source: 'official', status: 'blocked', observedAt: early },
        balance: {
          available: '11.25',
          pending: '9.30',
          availableEvidence: { source: 'official', observedAt: early },
          pendingEvidence: { source: 'official', observedAt: early },
        },
        lastObservation: {
          source: 'model',
          balance: { currency: 'EUR', available: null, pending: null },
        },
      },
    })
  })

  it('requires the current binding even when replaying an already recorded operation', async () => {
    const f = await fixture()
    await f.record({ summary: 'Recorded before unbinding.' })
    await f.call('vinted.accounts.unbind', { windowId })
    const before = await f.store.read()
    await expect(
      f.record({ summary: 'Recorded before unbinding.' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await f.store.read()).toEqual(before)
  })

  it('serializes concurrent use of an operation ID and commits only one input', async () => {
    const f = await fixture()
    const outcomes = await Promise.allSettled([
      f.record({ summary: 'First.' }),
      f.record({ summary: 'Conflicting.' }),
      f.record({ summary: 'First.' }),
    ])
    expect(outcomes.map((entry) => entry.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
    ])
    expect((await f.store.read()).accounts[0]).toMatchObject({
      observation: { summary: 'First.' },
    })
  })

  it('journals stale observations without overwriting newer state or blocking the account', async () => {
    const f = await fixture()
    await f.record({ observedAt: later, summary: 'Current.', tags: ['new'] })
    const before = (await f.store.read()).accounts
    expect(
      await f.record({
        operationId: otherOperationId,
        status: 'blocked',
        summary: 'Old.',
        tags: ['old'],
      }),
    ).toMatchObject({ applied: false })
    expect((await f.store.read()).accounts).toEqual(before)
    await f.record({ operationId: thirdOperationId, observedAt: now })
    expect(
      await f.record({
        operationId: otherOperationId,
        status: 'blocked',
        summary: 'Old.',
        tags: ['old'],
      }),
    ).toMatchObject({ applied: false })
  })

  it('keeps the first observation when a distinct operation has the same timestamp', async () => {
    const f = await fixture()
    await f.record({ summary: 'First.' })
    expect(
      await f.record({ operationId: otherOperationId, summary: 'Same time.' }),
    ).toMatchObject({ applied: false })
    expect((await f.store.read()).accounts[0]).toMatchObject({
      observation: { summary: 'First.' },
    })
  })

  it.each([
    ['official', 'blocked'],
    ['page', 'blocked'],
    ['model', 'active'],
  ])('applies blocked only with confirmed %s evidence', async (source, status) => {
    const f = await fixture()
    await f.record({ source, status: 'blocked' })
    expect((await f.store.read()).accounts[0]).toMatchObject({
      status,
      observation: { lastObservation: { source, status: 'blocked' } },
    })
  })

  it.each(['official', 'page'])(
    'preserves %s confirmed status across later model and status-free observations',
    async (source) => {
      const f = await fixture()
      await f.record({ source, status: 'limited' })
      await f.record({ operationId: otherOperationId, observedAt: later, tags: ['new'] })
      await f.record({
        operationId: thirdOperationId,
        observedAt: now,
        source: 'model',
        status: 'active',
      })
      expect((await f.store.read()).accounts[0]).toMatchObject({
        status: 'limited',
        observation: {
          statusEvidence: { source, status: 'limited', observedAt: early },
          lastObservation: { source: 'model', status: 'active' },
        },
      })
    },
  )

  it('allows model classification before confirmation but never clears an operator block', async () => {
    const f = await fixture()
    await f.record({ source: 'model', status: 'pending' })
    expect((await f.store.read()).accounts[0]?.status).toBe('pending')
    await f.store.mutate((document) => {
      document.accounts[0]!.status = 'blocked'
    })
    await f.record({
      operationId: otherOperationId,
      observedAt: later,
      source: 'model',
      status: 'active',
    })
    expect((await f.store.read()).accounts[0]?.status).toBe('blocked')
  })

  it.each(['blocked', 'limited', 'pending'])(
    'does not downgrade official %s status using page-only active evidence',
    async (status) => {
      const f = await fixture()
      await f.record({ status })
      await f.record({
        operationId: otherOperationId,
        observedAt: later,
        source: 'page',
        status: 'active',
      })
      expect((await f.store.read()).accounts[0]).toMatchObject({
        status,
        observation: {
          statusEvidence: { source: 'official', status, observedAt: early },
          lastObservation: { source: 'page', status: 'active' },
        },
      })
    },
  )

  it('allows page-confirmed blocking and later official recovery', async () => {
    const f = await fixture()
    await f.record({ status: 'active' })
    await f.record({
      operationId: otherOperationId,
      observedAt: later,
      source: 'page',
      status: 'blocked',
    })
    expect((await f.store.read()).accounts[0]?.status).toBe('blocked')
    await f.record({
      operationId: thirdOperationId,
      observedAt: now,
      source: 'official',
      status: 'active',
    })
    expect((await f.store.read()).accounts[0]?.status).toBe('active')
  })

  it('preserves observations through ordinary account edits and spreadsheet upserts', async () => {
    const f = await fixture()
    await f.record({ tags: ['seller'], summary: 'Keep observation.', rating: 4.5 })
    const before = (await f.store.read()).accounts[0]!
    const {
      id,
      loginMethod,
      account,
      password,
      phone,
      emailOtpUrl,
      smsOtpUrl,
      note,
      status,
      homepageUrl,
    } = before
    await f.call('vinted.accounts.save', {
      id,
      loginMethod,
      account,
      password,
      phone,
      emailOtpUrl,
      smsOtpUrl,
      note,
      status,
      homepageUrl,
    })
    expect(
      await f.call('vinted.accounts.import', {
        filename: 'accounts.csv',
        text: 'loginMethod,account,password\nemail,seller@example.test,synthetic replacement\n',
      }),
    ).toMatchObject({ updated: 1 })
    expect((await f.store.read()).accounts[0]?.observation).toEqual(before.observation)
    expect((await f.store.read()).accounts[0]?.password).toBe('synthetic replacement')
    expect((await f.store.read()).bindings).toHaveLength(1)
  })

  it('treats explicitly empty tags and summary and a zero rating as updates', async () => {
    const f = await fixture()
    await f.record({ tags: ['seller'], summary: 'Old.', rating: 4.5 })
    await f.record({
      operationId: otherOperationId,
      observedAt: later,
      tags: [],
      summary: '',
      rating: 0,
    })
    expect((await f.store.read()).accounts[0]).toMatchObject({
      observation: { tags: [], summary: '', rating: 0 },
    })
  })

  it.each(['unbind', 'rebind', 'remove'])(
    'rejects writes after a queued %s without resurrecting data',
    async (action) => {
      const f = await fixture()
      const change = f.store.mutate((document) => {
        if (action === 'remove') document.accounts = []
        else if (action === 'rebind') {
          document.accounts.push({
            ...document.accounts[0]!,
            id: otherOperationId,
            account: 'other-seller@example.test',
          })
          document.bindings[0]!.accountId = otherOperationId
        } else document.bindings = []
      })
      const write = f.record({ status: 'blocked' })
      await change
      const before = await f.store.read()
      await expect(write).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(await f.store.read()).toEqual(before)
    },
  )

  it('rejects an observation whose platform identity disagrees with the bound homepage', async () => {
    const f = await fixture()
    const before = await f.store.read()
    await expect(f.record({ platformUserId: '456' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(await f.store.read()).toEqual(before)
  })

  it('fails unbound snapshots and returns null for unknown platform identity', async () => {
    const f = await fixture()
    await f.store.mutate((document) => {
      document.accounts[0]!.homepageUrl = ''
    })
    expect(await f.call(snapshotMethod, { windowId })).toMatchObject({
      account: { accountId, platformUserId: null, observation: null },
      windowId,
    })
    await f.record({ platformUserId: '456' })
    expect(await f.call(snapshotMethod, { windowId })).toMatchObject({
      account: { accountId, platformUserId: '456' },
    })
    await f.call('vinted.accounts.unbind', { windowId })
    await expect(f.call(snapshotMethod, { windowId })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('does not record a cancelled operation that waited behind another writer', async () => {
    const f = await fixture()
    let release!: () => void
    const blocker = f.store.mutate(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await Promise.resolve()
    let alive = true
    const request = context(recordMethod, observation())
    request.assertAlive = () => {
      if (!alive) throw cancelled()
    }
    const write = f.pool.call(request)
    alive = false
    release()
    await blocker
    const before = await f.store.read()
    await expect(write).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(await f.store.read()).toEqual(before)
  })

  it('keeps memory, disk and idempotency receipts unchanged on a real write failure', async () => {
    const path = await directory()
    const f = await fixture(createFileStore(path))
    const before = await f.store.read()
    const bytes = await readFile(join(path, 'vinted-accounts.json'), 'utf8')
    const temporary = join(path, 'vinted-accounts.json.tmp')
    await mkdir(temporary)
    await expect(f.record({ status: 'blocked' })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    expect(await f.store.read()).toEqual(before)
    expect(await createFileStore(path).read()).toEqual(before)
    expect(await readFile(join(path, 'vinted-accounts.json'), 'utf8')).toBe(bytes)
    await rm(temporary, { recursive: true })
    expect(await f.record({ status: 'blocked' })).toMatchObject({ applied: true })
    expect((await createFileStore(path).read()).accounts[0]?.status).toBe('blocked')
  })

  it.each([
    { operationId: 'not-a-uuid' },
    { accountId: 'not-a-uuid' },
    { windowId: 'not-a-uuid' },
    { observedAt: 'yesterday' },
    { source: 'network-error' },
    { status: 'ready' },
    { password: 'synthetic' },
    { note: 'Do not overwrite the user note.' },
    { platformUserId: 'not-numeric' },
    { rating: -1 },
    { rating: 5.1 },
    { rating: Infinity },
    { tags: Array.from({ length: 9 }, () => 'tag') },
    { tags: ['x'.repeat(25)] },
    { tags: ['seller\u0000'] },
    { tags: ['seller\ud800'] },
    { summary: 'x'.repeat(161) },
    { summary: 'Invalid\u0000summary' },
    { summary: 'Invalid\ud800summary' },
    { balance: { currency: 'euro', available: '1', pending: null } },
    { balance: { currency: 'EUR', available: 0, pending: null } },
    { balance: { currency: 'EUR', available: '1e3', pending: null } },
    { balance: { currency: 'EUR', available: '0.12345', pending: null } },
    { balance: { currency: 'EUR', available: '1234567890123', pending: null } },
    { balance: { currency: 'EUR', available: '1' } },
    { balance: { currency: 'EUR', available: null, pending: null, secret: 'synthetic' } },
  ])('rejects malformed or out-of-scope observation input %j', async (fields) => {
    const f = await fixture()
    const before = await f.store.read()
    await expect(f.record(fields)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await f.store.read()).toEqual(before)
  })

  it('keeps existing window transfer working after recording an observation', async () => {
    const f = await fixture()
    await f.record({ tags: ['seller'], status: 'limited' })
    const result = await f.call('transfer.export', {
      windowIds: [windowId],
      endpointIds: [],
    })
    expect(result).toMatchObject({
      accounts: [
        {
          id: accountId,
          password: ' synthetic password with spaces ',
          status: 'limited',
        },
      ],
      bindings: [{ windowId, accountId }],
    })
  })
})
