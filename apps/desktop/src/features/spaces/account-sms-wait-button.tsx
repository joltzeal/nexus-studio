import { useSyncExternalStore } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toast'
import {
  emailWaits,
  smsWaits,
  startEmailWait,
  startSmsWait,
} from '@/features/accounts/sms-wait-runtime'
import { message, type Account } from '@/features/accounts/types'

export interface AccountSmsWaitButtonProps {
  account: Account
  windowId: string
  windowName: string
  ready: boolean
  emailReady?: boolean
}

export function AccountSmsWaitButton({
  account,
  windowId,
  windowName,
  ready,
  emailReady = false,
}: AccountSmsWaitButtonProps) {
  const sms = useSyncExternalStore(smsWaits.subscribe, smsWaits.getSnapshot)
  const email = useSyncExternalStore(emailWaits.subscribe, emailWaits.getSnapshot)
  const smsTask = sms.find((task) => task.accountId === account.id)
  const emailTask = email.find((task) => task.accountId === account.id)
  const mailbox = account.mailbox
  const actions = [
    {
      channel: 'SMS',
      task: smsTask,
      available: ready && !!account.phone.trim() && !!account.smsOtpUrl.trim(),
      hint: !account.phone.trim()
        ? '请先填写手机号。'
        : !account.smsOtpUrl.trim()
          ? '请先保存短信接码链接。'
          : '每 5 秒查询短信，最多等待 5 分钟。',
      run: () =>
        startSmsWait({
          accountId: account.id,
          accountName: account.account,
          windowId,
          windowName,
          phone: account.phone,
          smsOtpUrl: account.smsOtpUrl,
        }),
      stop: () => smsWaits.stop(account.id),
    },
    {
      channel: 'Email',
      task: emailTask,
      available: ready && emailReady && !!mailbox,
      hint: !mailbox
        ? '请先关联邮箱管理中的邮箱。'
        : !emailReady
          ? '邮箱插件尚未就绪。'
          : '每 5 秒查询关联邮箱，最多等待 5 分钟。',
      run: () =>
        mailbox &&
        startEmailWait({
          accountId: account.id,
          accountName: account.account,
          windowId,
          windowName,
          mailboxId: mailbox.mailboxId,
          mailboxEmail: mailbox.email,
          startedAt: Date.now(),
        }),
      stop: () => emailWaits.stop(account.id),
    },
  ] as const

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="text-xs text-muted-foreground">OTP:</span>
      {actions.map(({ channel, task, available, hint, run, stop }) => (
        <Button
          key={channel}
          type="button"
          variant={task ? 'secondary' : 'ghost'}
          size="xs"
          className="h-[22px] px-1.5"
          aria-label={`${task ? '停止等待' : '等待'} ${account.account} 的${channel}验证码`}
          aria-pressed={!!task}
          disabled={!task && !available}
          title={task ? `等待中，点击停止。${task.lastError ?? ''}` : hint}
          onClick={() => {
            if (task) {
              stop()
              return
            }
            if (!available) return
            try {
              run()
            } catch (cause) {
              toast.error(message(cause))
            }
          }}
        >
          {task && <Loader2 className="animate-spin" aria-hidden="true" />}
          {channel}
        </Button>
      ))}
    </span>
  )
}
