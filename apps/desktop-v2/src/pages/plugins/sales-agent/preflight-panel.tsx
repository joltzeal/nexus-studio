import { useEffect, useState } from 'react'
import type { AgentBatchCreate } from '@nexus/plugin-sdk/agent'
import { Alert, AlertDescription, Badge, Button, Skeleton } from './controls'

import { navigateDetail } from '../../../raccoon/plugins/detail-navigation'
import { checkAgentPreflight, type AgentTarget } from './api'
import { useAgentQuery } from './use-query'
import { useAgentConnection } from './scope'

export function PreflightPanel({
  input,
  targets,
  onReady,
  onSettings,
}: {
  input: AgentBatchCreate
  targets: AgentTarget[]
  onReady: (ready: boolean) => void
  onSettings: () => void
}) {
  const connectionId = useAgentConnection()
  const [attempt, setAttempt] = useState(0)
  const result = useAgentQuery(JSON.stringify([input, attempt]), () =>
    checkAgentPreflight(input, connectionId),
  )
  const ready = !!result.data?.ready && !result.error && !result.loading
  useEffect(() => {
    onReady(ready)
  }, [onReady, ready])
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="集中运行前检查">
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto text-help [&>*]:shrink-0">
        <strong>运行前检查</strong>
        <Badge variant={ready ? 'outline' : 'secondary'}>
          {ready ? '资料检查通过' : '尚未通过'}
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          disabled={result.loading}
          onClick={() => setAttempt((value) => value + 1)}
        >
          重新检查
        </Button>
      </div>
      <p className="text-help text-text-sub-600">
        这里核对已保存资料、关系和执行限制。登录状态及实际页面需在Profile启动后再次确认。
      </p>
      {result.loading ? (
        <Skeleton className="h-20 w-full" aria-label="正在运行前检查" />
      ) : null}
      {result.error ? (
        <Alert variant="destructive">
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      ) : null}
      <ul className="m-0 flex max-h-56 list-none flex-col gap-2 overflow-auto p-0 text-help [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:gap-2 [&>li>span:nth-child(2)]:min-w-40 [&>li>span:nth-child(2)]:flex-1">
        {result.data?.checks.map((check, index) => (
          <li key={`${check.code}-${index}`}>
            <Badge variant={check.severity === 'error' ? 'destructive' : 'outline'}>
              {check.severity === 'ok'
                ? '通过'
                : check.severity === 'warning'
                  ? '提醒'
                  : '需处理'}
            </Badge>
            <span>{check.message}</span>
            {check.action !== 'none' ? (
              <Button
                size="sm"
                variant="link"
                onClick={() => {
                  if (check.action === 'settings') {
                    onSettings()
                    return
                  }
                  if (check.action === 'product' && check.productId)
                    navigateDetail({ kind: 'product', id: check.productId })
                  else if (check.windowId) {
                    const accountId = targets.find(
                      (target) => target.id === check.windowId,
                    )?.account?.id
                    navigateDetail(
                      check.action === 'account' && accountId
                        ? { kind: 'account', id: accountId }
                        : { kind: 'window', id: check.windowId },
                    )
                  }
                }}
              >
                {check.action === 'settings'
                  ? '打开设置'
                  : check.action === 'product'
                    ? '查看商品'
                    : check.action === 'account'
                      ? '核对账号'
                      : '查看Profile'}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {result.data ? (
        <p className="text-help text-text-sub-600">
          检查时间 {new Date(result.data.checkedAt).toLocaleString()}
        </p>
      ) : null}
    </section>
  )
}
