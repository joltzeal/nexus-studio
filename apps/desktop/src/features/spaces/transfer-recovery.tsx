import { Loader2, RefreshCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { TransferRecoveryStatus } from '@/lib/platform/native-transfer'

const pendingWarning = '上次窗口迁移的插件资料尚待恢复，请安装或更新所需插件后刷新重试。'

export function TransferRecoveryNotice({
  status,
  error,
  checking,
  onRetry,
}: {
  status: TransferRecoveryStatus | null
  error: string | null
  checking: boolean
  onRetry: () => void
}) {
  const pending = status !== null && status.pending > 0
  if (!pending && error === null) return null
  const warnings = pending
    ? status.warnings.length
      ? status.warnings
      : [pendingWarning]
    : []

  return (
    <Alert>
      <AlertTitle>窗口迁移恢复</AlertTitle>
      <AlertDescription>
        {pending ? (
          <p>
            {error ? '上次读取时有' : '有'} {status.pending} 项迁移资料待恢复。
          </p>
        ) : null}
        {warnings.length ? (
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {warnings.map((warning, index) => (
              <li key={index} className="break-words">
                {warning}
              </li>
            ))}
          </ul>
        ) : null}
        {error ? <p role="alert">恢复状态尚未确认：{error}</p> : null}
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={checking}
          onClick={onRetry}
        >
          {checking ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          {checking ? '读取恢复状态中…' : '重试恢复'}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
