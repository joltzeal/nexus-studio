import type { AccountObservation } from './observation.ts'

export const SOURCE_LABELS = { official: '官方接口', page: '页面', model: '模型' }

export function balanceSummary(observation: AccountObservation | undefined) {
  return (['available', 'pending'] as const).map((key) => {
    const value = observation?.wallet?.[key]
    const failed = observation?.checks[`wallet.${key}`]?.outcome === 'failed'
    return {
      key,
      label: key === 'available' ? '可用' : '待结算',
      value: value ? `${value.amount} ${value.currency}` : '未知',
      source: value ? SOURCE_LABELS[value.source] : null,
      observedAt: value?.observedAt ?? null,
      retained: !!value && failed,
      failed,
    }
  })
}

export function bankSummary(observation: AccountObservation | undefined) {
  const bank = observation?.bankAccounts
  const failed = observation?.checks.bankAccounts?.outcome === 'failed'
  if (!bank)
    return { label: failed ? '读取失败，未检查' : '未检查', detail: null, failed }
  const defaults = bank.records.filter((record) => record.is_default)
  return {
    label: bank.records.length ? `${bank.records.length} 个收款账户` : '已检查，未绑定',
    detail: !bank.records.length
      ? null
      : defaults.length === 1
        ? defaults[0]!.account_number
        : defaults.length
          ? '默认项异常'
          : '无默认项',
    failed,
  }
}

export function sessionSummary(
  accountId: string,
  observation: AccountObservation | undefined,
  bindings: readonly { accountId: string; windowId: string; revision?: string }[],
) {
  return bindings
    .filter((binding) => binding.accountId === accountId)
    .map((binding) => {
      const observed = observation?.sessions[binding.windowId]
      const current =
        observed?.bindingRevision === binding.revision &&
        observed?.accountId === accountId
          ? observed
          : undefined
      return {
        profileId: binding.windowId,
        label: !current
          ? '未检查'
          : current.status === 'authenticated'
            ? '已登录'
            : '已掉登',
        observedAt: current?.observedAt ?? null,
        failed: observation?.checks[`session:${binding.windowId}`]?.outcome === 'failed',
      }
    })
}
