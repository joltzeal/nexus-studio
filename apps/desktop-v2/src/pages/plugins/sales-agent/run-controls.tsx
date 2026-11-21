import { useEffect, useRef, useState } from 'react'
import type { AgentBatchView, AgentJobView } from '@nexus/plugin-sdk/agent'
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from './controls'

import { agentError, controlAgentBatch, controlAgentJob, type AgentControl } from './api'
import { controlReason, jobControlReason } from './state'
import {
  PauseIcon,
  PlayIcon,
  CloseIcon,
  ComputerIcon,
  RefreshIcon,
  SyncIcon,
} from '../../../shared/icons'

const LABELS = {
  pause: '暂停',
  resume: '继续执行',
  cancel: '取消任务',
  takeover: '人工接管',
  reconcile: '核对结果',
  sync: '同步记录',
} as const
type Action = AgentControl | 'sync'
const ACTION_ICONS = {
  pause: PauseIcon,
  resume: PlayIcon,
  cancel: CloseIcon,
  takeover: ComputerIcon,
  reconcile: RefreshIcon,
  sync: SyncIcon,
}

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
  const active = useRef(false)
  const inFlight = useRef(false)
  const settlement = useRef<(() => void) | null>(null)
  const changed = useRef(onChanged)
  useEffect(() => {
    changed.current = onChanged
  }, [onChanged])
  useEffect(() => {
    active.current = true
    settlement.current?.()
    settlement.current = null
    return () => {
      active.current = false
    }
  }, [])
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
    if (inFlight.current || busy || stale || error || reason(action)) return
    inFlight.current = true
    setBusy(action)
    setNotice(null)
    try {
      if (job && action !== 'sync' && action !== 'reconcile')
        await controlAgentJob(job.id, action)
      else if (batch)
        await controlAgentBatch(batch.id, action === 'sync' ? 'reconcile' : action)
      const notice =
        action === 'takeover'
          ? '已请求接管。请等待Profile显示“已隔离，可人工操作”，再开始人工操作。'
          : action === 'sync'
            ? '已请求同步已有结果，请查看更新后的记录。'
            : action === 'reconcile'
              ? '已请求核对已有结果，不会重新提交。'
              : '操作已确认。'
      settlement.current = () => {
        setConfirm(null)
        setNotice(notice)
        changed.current()
        setBusy(null)
        inFlight.current = false
      }
    } catch (cause) {
      const error = `${agentError(cause)} 操作结果未确认，请刷新核对。`
      settlement.current = () => {
        setError(error)
        setBusy(null)
        inFlight.current = false
      }
    } finally {
      if (active.current) {
        settlement.current?.()
        settlement.current = null
      }
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto text-help [&>*]:shrink-0">
        {actions.map((action) => {
          const ActionIcon = ACTION_ICONS[action]
          return (
            <Button
              key={action}
              size={job ? 'icon' : 'sm'}
              isLoading={busy === action}
              aria-label={
                job
                  ? `${LABELS[action]}${reason(action) ? ` · ${reason(action)}` : ''}`
                  : undefined
              }
              variant={action === 'cancel' ? 'destructive' : 'outline'}
              disabled={!!busy || stale || !!error || !!reason(action)}
              hint={
                reason(action) ??
                (action === 'sync' ? '补写已确认的发布或账号记录' : LABELS[action])
              }
              onClick={() => {
                if (action === 'cancel' || action === 'takeover') setConfirm(action)
                else void control(action)
              }}
            >
              {job ? (
                <ActionIcon className="size-3.5" />
              ) : busy === action ? (
                '处理中…'
              ) : (
                LABELS[action]
              )}
            </Button>
          )
        })}
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
        <p className="text-help text-text-sub-600" role="status">
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
                ? '先停止后续派发并隔离执行Profile。隔离未确认前不能人工操作；已提交或结果不明的动作仍须核对。'
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
