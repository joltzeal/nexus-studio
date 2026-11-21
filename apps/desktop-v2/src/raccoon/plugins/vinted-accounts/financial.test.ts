import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bankSummary, balanceSummary, sessionSummary } from './financial.ts'
import type { AccountObservation } from './observation.ts'

test('balance summary preserves exact zeroes, unknown amounts and separate currencies', () => {
  const observation: AccountObservation = {
    sessions: {},
    checks: {
      'wallet.available': { outcome: 'failed', observedAt: '2026-11-19T00:00:00Z' },
    },
    wallet: {
      available: {
        amount: '0.0000',
        currency: 'USD',
        observedAt: '2026-11-18T00:00:00Z',
        source: 'official',
      },
      pending: null,
    },
  }
  assert.deepEqual(
    balanceSummary(observation).map(({ value, retained }) => ({ value, retained })),
    [
      { value: '0.0000 USD', retained: true },
      { value: '未知', retained: false },
    ],
  )
  assert.equal(balanceSummary(undefined)[0]?.value, '未知')
  observation.wallet!.pending = {
    amount: '12.3400',
    currency: 'EUR',
    observedAt: '2026-11-19T00:00:00Z',
    source: 'official',
  }
  assert.equal(balanceSummary(observation)[1]?.value, '12.3400 EUR')
})

test('bank summary distinguishes unread, checked empty and ambiguous defaults', () => {
  assert.deepEqual(bankSummary(undefined), {
    label: '未检查',
    detail: null,
    failed: false,
  })
  const observation: AccountObservation = {
    sessions: {},
    checks: {},
    bankAccounts: {
      records: [],
      observedAt: '2026-11-19T00:00:00Z',
      source: 'official',
      windowId: 'profile',
      bindingRevision: 'revision',
    },
  }
  assert.equal(bankSummary(observation).label, '已检查，未绑定')
  const bank = {
    id: '1',
    name: 'Name',
    account_number: '****1234',
    routing_number: '123456789',
    spending_type: 'checking',
    user_id: '2',
    hide_name: false,
    is_default: false,
  }
  observation.bankAccounts!.records = [bank]
  assert.equal(bankSummary(observation).detail, '无默认项')
  bank.is_default = true
  assert.equal(bankSummary(observation).detail, '****1234')
  observation.bankAccounts!.records.push({ ...bank, id: '3' })
  assert.equal(bankSummary(observation).detail, '默认项异常')
})

test('session summary ignores evidence belonging to an older binding', () => {
  const observation: AccountObservation = {
    sessions: {
      profile: {
        accountId: 'a',
        status: 'authenticated',
        observedAt: '2026-11-19T00:00:00Z',
        bindingRevision: 'old',
      },
    },
    checks: {},
  }
  const bindings = [{ accountId: 'a', windowId: 'profile', revision: 'new' }]
  assert.equal(sessionSummary('a', observation, bindings)[0]?.label, '未检查')
  observation.sessions.profile!.bindingRevision = 'new'
  assert.equal(sessionSummary('a', observation, bindings)[0]?.label, '已登录')
  observation.sessions.profile!.accountId = 'other'
  assert.equal(sessionSummary('a', observation, bindings)[0]?.label, '未检查')
})
