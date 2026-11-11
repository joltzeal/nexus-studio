import { Clock3, Loader2, RefreshCw, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { canonicalPhone } from './accounts-bridge'
import { expiryAssociations, type ExpiryAssociationProps } from './expiry-associations'
import { useNumberExpiry } from './use-number-expiry'
import type { ExpiryReminder } from './types'

export function ExpiryReminderRows({
  items,
  now,
  dismissing,
  onDismiss,
  ...associations
}: ExpiryAssociationProps & {
  now: number
  items: readonly ExpiryReminder[]
  dismissing: readonly string[]
  onDismiss: (item: ExpiryReminder) => void
}) {
  return (
    <ul className="max-h-48 w-full divide-y overflow-y-auto" aria-label="即将到期的号码">
      {items.map((item) => {
        const remaining = Math.max(
          1,
          Math.ceil((Date.parse(item.expiresAt) - now) / 86_400_000),
        )
        const at = new Date(item.expiresAt).toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
        return (
          <li
            key={canonicalPhone(item.tel)}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 text-xs">
                <strong className="font-mono text-foreground">{item.tel}</strong>
                <span className="text-destructive">
                  {remaining === 1 ? '24 小时内到期' : `${remaining} 天内到期`}
                </span>
                <time dateTime={item.expiresAt}>{at}</time>
              </div>
              <p className="break-words text-xs">
                {expiryAssociations(item.tel, associations)}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={dismissing.length > 0}
              aria-label={`今天不再提醒 ${item.tel}`}
              onClick={() => onDismiss(item)}
            >
              {dismissing.includes(item.tel) ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <X aria-hidden="true" />
              )}
              今天不再提醒
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

export function Sim8ExpiryNotice({
  refreshKey,
  now,
  ...associations
}: ExpiryAssociationProps & { refreshKey: number; now: number }) {
  const expiry = useNumberExpiry(refreshKey)
  if (expiry.availability !== 'ready') return null
  const { snapshot } = expiry
  const items = snapshot?.items.filter((item) => Date.parse(item.expiresAt) > now) ?? []
  const failed = snapshot?.failed ?? 0
  if (items.length === 0 && !expiry.error && failed === 0) return null
  return (
    <Alert role="status">
      <Clock3 aria-hidden="true" />
      <AlertTitle className="flex items-center justify-between gap-2">
        <span>{items.length ? `号码即将到期 · ${items.length}` : '号码到期检查'}</span>
        <Button
          variant="ghost"
          size="xs"
          disabled={expiry.checking}
          onClick={expiry.refresh}
        >
          <RefreshCw
            className={expiry.checking ? 'animate-spin' : undefined}
            aria-hidden="true"
          />
          {expiry.checking ? '检查中…' : '刷新提醒'}
        </Button>
      </AlertTitle>
      <AlertDescription>
        {items.length > 0 ? (
          <ExpiryReminderRows
            {...associations}
            now={now}
            items={items}
            dismissing={expiry.dismissing}
            onDismiss={(item) => void expiry.dismiss(item)}
          />
        ) : null}
        {failed > 0 ? (
          <p className="text-xs">
            {failed} 个号码的到期时间暂未更新，已保留上次记录，稍后自动重试。
          </p>
        ) : null}
        {snapshot?.storageDurable === false ? (
          <p className="text-xs">“今天不再提醒”仅对本次使用有效。</p>
        ) : null}
        {expiry.error ? (
          <p className="text-xs text-destructive" role="alert">
            {expiry.error}
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
