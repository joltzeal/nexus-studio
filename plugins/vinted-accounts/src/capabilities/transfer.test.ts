import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { cancelled } from '../domain/errors.js'
import type { AccountRecord } from '../domain/types.js'
import { createVintedAccountsPlugin } from '../index.js'
import type { DispatchContext } from '../rpc/protocol.js'

const diagnostics = new Writable({ write: (_chunk, _encoding, done) => done() })
const transactionId = 'ed59b730-6308-4f20-8d3a-02f71b9614ba'

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

async function sourceData() {
  const source = createVintedAccountsPlugin({ diagnostics })
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
  return source.plugin.call(
    context('transfer.export', { windowIds: ['old'], endpointIds: [] }),
  )
}

describe('account transfer atomicity', () => {
  it('does not undo an already applied transaction when an idempotent retry is cancelled', async () => {
    const data = await sourceData()
    const target = createVintedAccountsPlugin({ diagnostics })
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
    const target = createVintedAccountsPlugin({ diagnostics })
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
    const target = createVintedAccountsPlugin({ diagnostics })
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
