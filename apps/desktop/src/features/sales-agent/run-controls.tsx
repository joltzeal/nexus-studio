import { useEffect, useState } from 'react'
import type { AgentBatchView, AgentJobView } from '@nexus/plugin-sdk/agent'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { agentError, controlAgentBatch, controlAgentJob, type AgentControl } from './api'
import { controlReason, jobControlReason, RequestScope } from './state'

const LABELS = {
  pause: '暂停',
  resume: '继续执行',
  cancel: '取消任务',
  takeover: '人工接管',
  reconcile: '核对结果',
  sync: '同步记录',
} as const
type Action = AgentControl | 'sync'

export function RunControls({
  batch,
  jobs = [],
  job,
  stale = false,
  onChanged,
}: {
  batch?: AgentBatchView
  jobs?: AgentJobView[]
  job?: AgentJobView
  stale?: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState<Action | null>(null)
  const [confirm, setConfirm] = useState<'cancel' | 'takeover' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [scope] = useState(() => new RequestScope())
  useEffect(() => () => scope.invalidate(), [scope])
  const actions: Action[] = job
    ? ['pause', 'resume', 'takeover', 'cancel']
    : ['pause', 'resume', 'reconcile', 'sync', 'takeover', 'cancel']

  function reason(action: Action) {
    if (job)
      return action === 'reconcile' || action === 'sync'
        ? '请在批次中核对结果。'
        : jobControlReason(job, action)
    return batch
      ? controlReason(batch, jobs, action === 'sync' ? 'reconcile' : action)
      : '正在读取任务。'
  }

  async function control(action: Action) {
    if (busy || stale || error || reason(action)) return
    const current = scope.begin()
    setBusy(action)
    setNotice(null)
    try {
      if (job && action !== 'sync' && action !== 'reconcile')
        await controlAgentJob(job.id, action)
      else if (batch)
        await controlAgentBatch(batch.id, action === 'sync' ? 'reconcile' : action)
      if (!current()) return
      setConfirm(null)
      setNotice(
        action === 'takeover'
          ? '已请求接管。请等待窗口显示“已隔离，可人工操作”，再开始人工操作。'
          : action === 'sync'
            ? '已请求同步已有结果，请查看更新后的记录。'
            : action === 'reconcile'
              ? '已请求核对已有结果，不会重新提交。'
              : '操作已确认。',
      )
      onChanged()
    } catch (cause) {
      if (current()) setError(`${agentError(cause)} 操作结果未确认，请刷新核对。`)
    } finally {
      if (current()) setBusy(null)
    }
  }

  return (
    <div className="sales-agent-control-group">
      <div className="sales-agent-toolbar">
        {actions.map((action) => (
          <Button
            key={action}
            size="sm"
            variant={action === 'cancel' ? 'destructive' : 'outline'}
            disabled={!!busy || stale || !!error || !!reason(action)}
            title={
              reason(action) ??
              (action === 'sync' ? '补写已确认的发布或账号记录' : LABELS[action])
            }
            onClick={() => {
              if (action === 'cancel' || action === 'takeover') setConfirm(action)
              else void control(action)
            }}
          >
            {busy === action ? '处理中…' : LABELS[action]}
          </Button>
        ))}
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setError(null)
              onChanged()
            }}
          >
            刷新核对状态
          </Button>
        </Alert>
      ) : null}
      {notice ? (
        <p className="sales-agent-control-help" role="status">
          {notice}
        </p>
      ) : null}
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'takeover' ? '请求人工接管？' : '取消此任务？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'takeover'
                ? '先停止后续派发并隔离执行窗口。隔离未确认前不能人工操作；已提交或结果不明的动作仍须核对。'
                : '停止后续派发，保留已完成事实。已提交的刊登或消息无法撤回，未知结果仍须核对。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>返回</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!busy}
              onClick={(event) => {
                event.preventDefault()
                if (confirm) void control(confirm)
              }}
            >
              {busy ? '处理中…' : confirm === 'takeover' ? '确认请求接管' : '确认取消'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
