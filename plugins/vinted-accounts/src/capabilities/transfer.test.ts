import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import type { AccountAddressProfile } from '../domain/address.js'
import { cancelled } from '../domain/errors.js'
import type { AccountTransferData } from '../domain/transfer.js'
import type { AccountRecord } from '../domain/types.js'
import { createVintedAccountsPlugin, type VintedAccountsPluginOptions } from '../index.js'
import type { DispatchContext } from '../rpc/protocol.js'

const diagnostics = new Writable({ write: (_chunk, _encoding, done) => done() })
const transactionId = 'ed59b730-6308-4f20-8d3a-02f71b9614ba'
const linkedAt = '2026-11-11T10:00:00.000Z'
const profile: AccountAddressProfile = {
  id: 'address-1',
  street: 'Example Street',
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
  lastName: 'Example',
  username: 'marie.example',
}
const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function createPlugin(options: VintedAccountsPluginOptions = {}) {
  return createVintedAccountsPlugin({
    diagnostics,
    input: new PassThrough(),
    now: () => new Date(linkedAt),
    ...options,
  })
}

function context(method: string, payload: unknown): DispatchContext {
  return {
    requestId: method,
    capability: 'account.pool',
    method,
    payload,
    deadlineAt: Date.now() + 30_000,
    assertAlive: () => undefined,
  }
}

async function sourceData(address?: AccountAddressProfile): Promise<AccountTransferData> {
  const source = createPlugin()
  const saved = (await source.plugin.call(
    context('vinted.accounts.save', {
      loginMethod: 'email',
      account: 'portable@example.test',
      password: 'portable-password',
      phone: '',
      emailOtpUrl: '',
      smsOtpUrl: '',
      note: '',
      status: 'pending',
      homepageUrl: '',
    }),
  )) as { item: AccountRecord }
  await source.plugin.call(
    context('vinted.accounts.bind', { accountId: saved.item.id, windowId: 'old' }),
  )
  if (address !== undefined) {
    await source.plugin.call(
      context('vinted.accounts.address.set', {
        accountId: saved.item.id,
        profile: address,
        expectedProfileId: null,
      }),
    )
  }
  return source.plugin.call(
    context('transfer.export', { windowIds: ['old'], endpointIds: [] }),
  ) as Promise<AccountTransferData>
}

describe('account transfer atomicity', () => {
  it('preserves a validated account address snapshot through export and import', async () => {
    const data = await sourceData(profile)
    const address = { ...profile, linkedAt }
    expect(data.accounts[0]?.address).toEqual(address)
    const target = createPlugin()
    await target.plugin.call(
      context('transfer.import', {
        data,
        windowIdMap: { old: 'new' },
      }),
    )
    const stored = (await target.store.read()).accounts[0]!
    expect(stored).toMatchObject({ address, account: 'portable@example.test' })
    expect(stored.id).not.toBe(data.accounts[0]!.id)
    expect(
      await target.plugin.call(
        context('transfer.export', {
          windowIds: ['new'],
          endpointIds: [],
        }),
      ),
    ).toMatchObject({ accounts: [{ address }] })
    const before = await target.store.read()
    for (const patch of [{ latitude: 91 }, { linkedAt: 'invalid' }, { extra: true }]) {
      Object.assign(data.accounts[0]!, { address: { ...address, ...patch } })
      await expect(
        target.plugin.call(
          context('transfer.import', {
            data,
            windowIdMap: { old: 'other' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(await target.store.read()).toEqual(before)
    }
  })

  it('reopens an imported snapshot and exports it again without the address plugin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-address-transfer-'))
    directories.push(directory)
    const data = await sourceData(profile)
    const target = createPlugin({ storageDirectory: directory })
    const payload = { data, windowIdMap: { old: 'new' }, transactionId }
    await target.plugin.call(context('transfer.import', payload))
    const restarted = createPlugin({ storageDirectory: directory })
    const account = (await restarted.store.read()).accounts[0]!
    expect(account).toEqual({ ...data.accounts[0], id: account.id })
    expect(account.id).not.toBe(data.accounts[0]!.id)
    expect(
      await restarted.plugin.call(
        context('transfer.export', {
          windowIds: ['new'],
          endpointIds: [],
        }),
      ),
    ).toEqual({
      schemaVersion: 1,
      accounts: [account],
      bindings: [{ ...data.bindings[0], accountId: account.id, windowId: 'new' }],
    })
    await restarted.plugin.call(context('transfer.commit', { receipt: transactionId }))
    expect(
      (await createPlugin({ storageDirectory: directory }).store.read()).accounts[0]
        ?.address,
    ).toEqual({ ...profile, linkedAt })
  })

  it('leaves no imported snapshot on a real write failure and accepts the same transaction on retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-address-transfer-failure-'))
    directories.push(directory)
    const data = await sourceData(profile)
    const target = createPlugin({ storageDirectory: directory })
    const before = await target.store.read()
    const temporary = join(directory, 'vinted-accounts.json.tmp')
    await mkdir(temporary)
    const payload = { data, windowIdMap: { old: 'new' }, transactionId }
    await expect(
      target.plugin.call(context('transfer.import', payload)),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    expect(await target.store.read()).toEqual(before)
    expect(await createPlugin({ storageDirectory: directory }).store.read()).toEqual(
      before,
    )
    await rm(temporary, { recursive: true })
    await target.plugin.call(context('transfer.import', payload))
    expect(
      (await createPlugin({ storageDirectory: directory }).store.read()).accounts[0]
        ?.address,
    ).toEqual({ ...profile, linkedAt })
  })

  it.each(['absent', 'null'] as const)(
    'imports an account whose optional address is %s',
    async (value) => {
      const data = await sourceData()
      if (value === 'absent') delete data.accounts[0]!.address
      const target = createPlugin()
      await target.plugin.call(
        context('transfer.import', {
          data,
          windowIdMap: { old: 'new' },
        }),
      )
      const account = (await target.store.read()).accounts[0]!
      if (value === 'absent') expect(account).not.toHaveProperty('address')
      else expect(account).toHaveProperty('address', null)
    },
  )

  it('does not undo an already applied transaction when an idempotent retry is cancelled', async () => {
    const data = await sourceData()
    const target = createPlugin()
    const payload = { data, windowIdMap: { old: 'new' }, transactionId }
    await target.plugin.call(context('transfer.import', payload))
    const before = await target.store.read()
    const retry = context('transfer.import', payload)
    let checks = 0
    retry.assertAlive = () => {
      if (++checks === 2) throw cancelled()
    }
    await expect(target.plugin.call(retry)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(await target.store.read()).toEqual(before)
  })

  it('compensates a cancelled new import including its same-id replacement binding', async () => {
    const data = await sourceData()
    const target = createPlugin()
    await target.store.mutate((document) => {
      document.accounts.push({
        id: 'keep',
        loginMethod: 'email',
        account: 'keep@example.test',
        password: 'keep-password',
        phone: '',
        emailOtpUrl: '',
        smsOtpUrl: '',
        note: '',
        status: 'active',
        homepageUrl: '',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      })
      document.bindings.push({
        windowId: 'old',
        accountId: 'keep',
        boundAt: '2026-01-01T00:00:00Z',
      })
    })
    const before = await target.store.read()
    const request = context('transfer.import', {
      data,
      windowIdMap: { old: 'old' },
      transactionId,
    })
    let checks = 0
    request.assertAlive = () => {
      if (++checks === 2) throw cancelled()
    }
    await expect(target.plugin.call(request)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(await target.store.read()).toEqual(before)
  })

  it('enforces the account limit before creating any records or bindings', async () => {
    const data = await sourceData()
    const target = createPlugin()
    await target.store.mutate((document) => {
      for (let id = 0; id < 2000; id += 1) {
        document.accounts.push({
          id: String(id),
          loginMethod: 'email',
          account: `keep-${String(id)}@example.test`,
          password: 'keep-password',
          phone: '',
          emailOtpUrl: '',
          smsOtpUrl: '',
          note: '',
          status: 'active',
          homepageUrl: '',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        })
      }
    })
    const before = await target.store.read()
    await expect(
      target.plugin.call(
        context('transfer.import', {
          data,
          windowIdMap: { old: 'new' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await target.store.read()).toEqual(before)
  })
})
