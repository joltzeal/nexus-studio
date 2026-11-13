import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PopoverContent } from '@/components/ui/popover'
import { components } from '@/features/settings/kernel-test-support'
import { accountBalanceData } from './account-observation-data'
import {
  AccountObservationBalance,
  AccountObservationSummary,
} from './account-observation'
import {
  accountObservation,
  balanceTime,
  observationTime,
} from './account-observation-test-support'

describe('account observation render data', () => {
  it('pairs exact retained amounts with their own evidence instead of the latest observation', () => {
    expect(accountBalanceData(accountObservation())).toEqual({
      currency: 'EUR',
      amounts: [
        {
          key: 'available',
          label: '可用',
          amount: '123456789012.3400',
          sourceLabel: '官方接口',
          observedAt: '2026-11-12T05:00:00.000Z',
          retained: true,
        },
        {
          key: 'pending',
          label: '待结算',
          amount: '0.00',
          sourceLabel: '页面',
          observedAt: '2026-11-13T06:00:00.000Z',
          retained: false,
        },
      ],
    })
  })

  it('shows null amounts as unknown without inventing evidence from the latest read', () => {
    const observation = accountObservation()
    expect(
      accountBalanceData({
        ...observation,
        balance: {
          currency: 'GBP',
          available: null,
          pending: null,
          availableEvidence: null,
          pendingEvidence: null,
        },
        lastObservation: {
          ...observation.lastObservation,
          balance: { currency: 'GBP', available: null, pending: null },
        },
      }),
    ).toEqual({
      currency: 'GBP',
      amounts: [
        {
          key: 'available',
          label: '可用',
          amount: '—',
          sourceLabel: null,
          observedAt: null,
          retained: false,
        },
        {
          key: 'pending',
          label: '待结算',
          amount: '—',
          sourceLabel: null,
          observedAt: null,
          retained: false,
        },
      ],
    })
  })

  it('does not mistake a later observation without a balance read for a failed read', () => {
    const observation = accountObservation()
    delete observation.lastObservation.balance
    const data = accountBalanceData(observation)

    expect(data?.amounts.map((entry) => entry.retained)).toEqual([false, false])
    expect(data?.amounts[0]?.observedAt).toBe(balanceTime)
  })

  it('keeps the stored currency when an unknown read in a different currency retained old amounts', () => {
    const observation = accountObservation()
    const data = accountBalanceData({
      ...observation,
      lastObservation: {
        ...observation.lastObservation,
        balance: { currency: 'USD', available: null, pending: null },
      },
    })

    expect(data?.currency).toBe('EUR')
    expect(data?.amounts.map((entry) => entry.amount)).toEqual([
      '123456789012.3400',
      '0.00',
    ])
    expect(data?.amounts.map((entry) => entry.retained)).toEqual([true, true])
    expect(data?.amounts[0]?.sourceLabel).toBe('官方接口')
  })

  it('keeps negative decimal text and marks model evidence explicitly', () => {
    const observation = accountObservation()
    const data = accountBalanceData({
      ...observation,
      balance: {
        currency: 'EUR',
        available: '-0.0001',
        pending: null,
        availableEvidence: { source: 'model', observedAt: balanceTime },
        pendingEvidence: null,
      },
    })

    expect(data?.amounts[0]).toMatchObject({
      amount: '-0.0001',
      sourceLabel: '模型',
      observedAt: balanceTime,
    })
    expect(data?.amounts[1]?.amount).toBe('—')
  })

  it('does not infer aggregate balances from the raw last observation', () => {
    const observation = accountObservation()
    delete observation.balance

    expect(accountBalanceData(undefined)).toBeNull()
    expect(accountBalanceData(observation)).toBeNull()
  })
})

describe('read-only account observation components', () => {
  it('renders summary text safely and displays zero ratings', () => {
    const html = renderToStaticMarkup(
      createElement(AccountObservationSummary, {
        observation: {
          ...accountObservation(),
          tags: ['<tag>', '<tag>'],
          summary: '<script>alert("test")</script>',
          rating: 0,
        },
      }),
    )

    expect(html).toContain('&lt;tag&gt;')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('评分 0/5')
    expect(html).not.toMatch(/<(input|textarea|button)\b/)
  })

  it('omits empty metadata rather than showing a fake rating or summary', () => {
    expect(
      renderToStaticMarkup(
        createElement(AccountObservationSummary, { observation: undefined }),
      ),
    ).toBe('')
    expect(
      renderToStaticMarkup(
        createElement(AccountObservationSummary, {
          observation: {
            lastObservation: accountObservation().lastObservation,
            tags: [],
            summary: '',
          },
        }),
      ),
    ).toBe('')
  })

  it('shows each amount with its original source and machine-readable observation time in the popover', () => {
    const tree = AccountObservationBalance({
      accountName: 'seller@example.test',
      observation: accountObservation(),
    })
    const content = components(tree, PopoverContent)[0]!
    const html = renderToStaticMarkup(
      createElement(Fragment, null, content.props.children),
    )
    const sections = html.match(/<dl\b[^>]*>[\s\S]*?<\/dl>/g) ?? []

    expect(sections).toHaveLength(1)
    expect(html).toContain('123456789012.3400')
    expect(html).toContain('0.00')
    expect(html).toContain('官方接口')
    expect(html).toContain('页面')
    expect(html).toContain(`dateTime="${balanceTime}"`)
    expect(html).toContain(`dateTime="${observationTime}"`)
    expect(html).toContain('最近读取未知，保留此前金额')
  })

  it('shows a plain dash for accounts without balance observations', () => {
    const html = renderToStaticMarkup(
      createElement(AccountObservationBalance, {
        accountName: 'seller@example.test',
        observation: undefined,
      }),
    )

    expect(html).toMatch(/^<span\b[^>]*>—<\/span>$/)
    expect(html).not.toContain('button')
  })
})
