import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AccountObservationState } from '@nexus/plugin-contracts/vinted-accounts'
import * as observations from './account-observation'
import { accountBalanceData } from './account-observation-data'

const windowId = '22222222-2222-4222-8222-222222222222'
const accountId = '11111111-1111-4111-8111-111111111111'
const revision = '33333333-3333-4333-8333-333333333333'
const observedAt = '2026-11-14T08:00:00.000Z'
const bank = {
  id: '789',
  user_id: '123',
  name: 'Synthetic Holder',
  account_number: '******4321',
  routing_number: '012345678',
  spending_type: 'unknown-original',
  hide_name: false,
  is_default: true,
}
const state = (): AccountObservationState => ({
  sessions: {},
  checks: {},
  wallet: {
    available: { amount: '0.0', currency: 'USD', observedAt, source: 'official' },
    pending: { amount: '19.2300', currency: 'EUR', observedAt, source: 'official' },
  },
  bankAccounts: {
    records: [bank],
    observedAt,
    source: 'official',
    windowId,
    bindingRevision: revision,
  },
})

describe('account evidence presentation', () => {
  it('shows independent currency, decimal text, evidence and retained markers per Money', () => {
    const observation = state()
    observation.checks['wallet.available'] = {
      sequence: 2,
      operationId: revision,
      observedAt,
      source: 'official',
      outcome: 'failed',
      code: 'unreadable',
    }
    expect(accountBalanceData(observation)?.amounts).toEqual([
      {
        key: 'available',
        label: '可用',
        amount: '0.0',
        currency: 'USD',
        observedAt,
        sourceLabel: '官方接口',
        retained: true,
      },
      {
        key: 'pending',
        label: '待结算',
        amount: '19.2300',
        currency: 'EUR',
        observedAt,
        sourceLabel: '官方接口',
        retained: false,
      },
    ])
    const html = renderToStaticMarkup(
      createElement(observations.AccountObservationBalance, {
        accountName: 'seller@example.test',
        observation,
      }),
    )
    expect(html).toContain('USD')
    expect(html).toContain('EUR')
    expect(html).toContain('0.0')
    expect(html).not.toContain('19.23 USD')
  })

  it('shows window-specific login and treats mismatched revisions as uninspected', () => {
    const observation = state()
    observation.sessions[windowId] = {
      accountId,
      windowId,
      bindingRevision: revision,
      observedAt,
      source: 'official',
      status: 'logged_out',
      reason: 'current_access_denied',
      platformUserId: null,
    }
    const render = (bindingRevision: string) =>
      renderToStaticMarkup(
        createElement(observations.AccountWindowSessions, {
          accountId,
          observation,
          bindings: [
            { accountId, windowId, revision: bindingRevision, boundAt: observedAt },
          ],
        }),
      )
    expect(render(revision)).toContain('已掉登')
    expect(render(revision)).toContain(observedAt)
    expect(render('44444444-4444-4444-8444-444444444444')).toContain('未检查')
    expect(render('44444444-4444-4444-8444-444444444444')).not.toContain('已掉登')
  })

  it('keeps names and routing numbers out of list markup, exposes masked summary and check time', () => {
    const html = renderToStaticMarkup(
      createElement(observations.AccountBankSummary, {
        accountName: 'seller@example.test',
        observation: state(),
        onDetails: () => undefined,
      }),
    )
    expect(html).toContain('1 个收款账户')
    expect(html).toContain(bank.account_number)
    expect(html).toContain(observedAt)
    expect(html).not.toContain(bank.name)
    expect(html).not.toContain(bank.routing_number)
  })

  it('distinguishes uninspected, successful empty, failed retained and abnormal default bank lists', () => {
    const render = (observation: AccountObservationState | undefined) =>
      renderToStaticMarkup(
        createElement(observations.AccountBankSummary, {
          accountName: 'seller@example.test',
          observation,
          onDetails: () => undefined,
        }),
      )
    expect(render(undefined)).toContain('未检查')
    const empty = state()
    empty.bankAccounts!.records = []
    expect(render(empty)).toContain('已检查，未绑定')
    const abnormal = state()
    abnormal.bankAccounts!.records.push({ ...bank, id: '790' })
    expect(render(abnormal)).toContain('默认项异常')
    abnormal.bankAccounts!.records.forEach((record) => {
      record.is_default = false
    })
    expect(render(abnormal)).toContain('无默认项')
    abnormal.checks.bankAccounts = {
      sequence: 3,
      operationId: revision,
      observedAt,
      source: 'official',
      outcome: 'failed',
      code: 'network_error',
    }
    expect(render(abnormal)).toContain('本次读取失败，保留此前资料')
  })

  it('honors hide_name in explicit bank details and preserves the routing string', () => {
    const observation = state()
    const render = () =>
      renderToStaticMarkup(
        createElement(observations.AccountBankDetails, {
          bankAccounts: observation.bankAccounts!,
        }),
      )
    expect(render()).toContain(bank.name)
    expect(render()).toContain('012345678')
    observation.bankAccounts!.records[0]!.hide_name = true
    expect(render()).not.toContain(bank.name)
    expect(render()).toContain('平台隐藏姓名')
  })
})
