import type { AccountObservationState } from '@nexus/plugin-contracts/vinted-accounts'

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
  const balance = observation.wallet
  if (balance === undefined) return null

  return {
    amounts: (['available', 'pending'] as const).map((key) => {
      const money = balance[key]
      return {
        key,
        label: AMOUNT_LABELS[key],
        amount: money?.amount ?? '—',
        currency: money?.currency ?? null,
        sourceLabel: money === null ? null : SOURCE_LABELS[money.source],
        observedAt: money?.observedAt ?? null,
        retained:
          money !== null && observation.checks[`wallet.${key}`]?.outcome === 'failed',
      }
    }),
  }
}
