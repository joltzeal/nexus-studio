import type { Account } from '../../../raccoon/plugins/vinted-accounts/model'
import { KeyIcon, MessageIcon } from '../../../shared/icons'
import { PluginRowAction } from '../PluginRowAction'

export type AccountOtpResult = {
  channel: 'email' | 'sms'
  code: string | null
  body: string
  truncated: boolean
  fetchedAt: string
}

export type AccountOtpCache = Record<
  string,
  { revision: string; result: AccountOtpResult }
>

export function AccountOtpCell({
  account,
  channel,
  codes,
  busy,
  onRead,
  onView,
}: {
  account: Account
  channel: 'email' | 'sms'
  codes: AccountOtpCache
  busy: boolean
  onRead: () => void
  onView: (result: AccountOtpResult) => void
}) {
  const cached = codes[`${account.id}:${channel}`]
  const result = cached?.revision === account.updatedAt ? cached.result : null
  const name = channel === 'sms' ? '短信' : '邮箱'
  if (!(channel === 'sms' ? account.smsOtpUrl : account.emailOtpUrl)) return null
  return (
    <>
      <PluginRowAction
        label={`读取${name}验证码`}
        icon={<KeyIcon className="size-3.5" />}
        disabled={busy}
        onClick={onRead}
      />
      {result && (
        <PluginRowAction
          label={`查看${name}验证码和原文`}
          icon={<MessageIcon className="size-3.5" />}
          onClick={() => onView(result)}
        />
      )}
    </>
  )
}
