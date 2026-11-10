import type { Account, BindingView } from '@/features/accounts/types'
import type { BrowserWindow } from '@/lib/platform/windows'
import { canonicalPhone } from './accounts-bridge'

export interface ExpiryAssociationProps {
  accounts: readonly Account[] | null
  bindings: readonly BindingView[]
  windows: readonly BrowserWindow[]
}

export function expiryAssociations(
  tel: string,
  { accounts, bindings, windows }: ExpiryAssociationProps,
): string {
  if (accounts === null) return '账号关联信息暂不可用'
  const phone = canonicalPhone(tel)
  const matching = accounts.filter(
    (account) => phone !== '' && canonicalPhone(account.phone) === phone,
  )
  if (matching.length === 0) return '未关联账号'
  return matching
    .map((account) => {
      const ids = new Set(
        bindings
          .filter((binding) => binding.accountId === account.id)
          .map((binding) => binding.windowId),
      )
      const names = windows
        .filter((window) => ids.has(window.id))
        .map((window) => window.name)
      return `${account.account} · ${names.length ? names.join('、') : '未关联窗口'}`
    })
    .join('；')
}
