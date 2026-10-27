import { useSyncExternalStore } from 'react'
import { Bell, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toast'
import { smsWaits, startSmsWait } from '@/features/accounts/sms-wait-runtime'
import { message, type Account } from '@/features/accounts/types'

export interface AccountSmsWaitButtonProps {
  account: Account
  windowId: string
  windowName: string
  ready: boolean
}

export function AccountSmsWaitButton({
  account,
  windowId,
  windowName,
  ready,
}: AccountSmsWaitButtonProps) {
  const tasks = useSyncExternalStore(
    smsWaits.subscribe,
    smsWaits.getSnapshot,
    smsWaits.getSnapshot,
  )
  const task = tasks.find((entry) => entry.accountId === account.id)
  if (!account.phone.trim()) return null
  const available = ready && !!account.smsOtpUrl.trim()
  const hint = task
    ? `每 5 秒查询，最多等待 5 分钟。点击停止等待。${task.lastError ? `上次查询失败，将继续重试：${task.lastError}` : ''}`
    : !account.smsOtpUrl.trim()
      ? '请先保存此账号的短信接码链接。'
      : !ready
        ? '账号插件尚未就绪或手机号正在更新。'
        : '每 5 秒查询验证码，收到后通知，最多等待 5 分钟。'
  return (
    <Button
      type="button"
      variant={task ? 'secondary' : 'ghost'}
      size="xs"
      className="h-[22px] px-1.5"
      aria-label={`${task ? '停止等待' : '等待'} ${account.account} 的验证码`}
      aria-pressed={!!task}
      disabled={!task && !available}
      title={hint}
      onClick={() => {
        if (task) {
          smsWaits.stop(account.id)
          return
        }
        if (
          !available ||
          smsWaits.getSnapshot().some((entry) => entry.accountId === account.id)
        )
          return
        try {
          startSmsWait({
            accountId: account.id,
            accountName: account.account,
            windowId,
            windowName,
            phone: account.phone,
            smsOtpUrl: account.smsOtpUrl,
          })
        } catch (cause) {
          toast.error(message(cause))
        }
      }}
    >
      {task ? (
        <Loader2 className="animate-spin" aria-hidden="true" />
      ) : (
        <Bell aria-hidden="true" />
      )}
      {task ? '等待中' : '等待验证码'}
    </Button>
  )
}
