import type { AccountObservationState } from '@nexus/plugin-vinted-accounts/agent-contracts'

const SOURCE_LABELS = {
  official: '官方接口',
  page: '页面',
  model: '模型',
} as const

const AMOUNT_LABELS = {
  available: '可用',
  pending: '待结算',
} as const

export function accountBalanceData(observation: AccountObservationState | undefined) {
  if (observation === undefined) return null
  const balance = observation.balance
  if (balance === undefined) return null

  return {
    currency: balance.currency,
    amounts: (['available', 'pending'] as const).map((key) => {
      const evidence = balance[`${key}Evidence`]
      return {
        key,
        label: AMOUNT_LABELS[key],
        amount: balance[key] ?? '—',
        sourceLabel: evidence === null ? null : SOURCE_LABELS[evidence.source],
        observedAt: evidence?.observedAt ?? null,
        retained:
          balance[key] !== null && observation.lastObservation.balance?.[key] === null,
      }
    }),
  }
}
