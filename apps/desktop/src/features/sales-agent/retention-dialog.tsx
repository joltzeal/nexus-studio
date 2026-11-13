import { useEffect, useState } from 'react'
import type { AgentRetentionPreview } from '@nexus/plugin-sdk/agent'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { agentError, cleanAgentRetention, previewAgentRetention } from './api'
import { RequestScope } from './state'

export function RetentionDialog({
  onClose,
  onCleaned,
}: {
  onClose: () => void
  onCleaned: () => void
}) {
  const [days, setDays] = useState(30)
  const [preview, setPreview] = useState<AgentRetentionPreview | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [scope] = useState(() => new RequestScope())
  useEffect(() => () => scope.invalidate(), [scope])
  async function inspect() {
    if (busy) return
    const current = scope.begin()
    setBusy(true)
    setError(null)
    setNotice(null)
    setPreview(null)
    try {
      const result = await previewAgentRetention(days)
      if (current()) setPreview(result)
    } catch (cause) {
      if (current()) setError(agentError(cause))
    } finally {
      if (current()) setBusy(false)
    }
  }
  async function clean() {
    if (busy || !preview) return
    const token = preview.token
    const current = scope.begin()
    setBusy(true)
    setError(null)
    try {
      const result = await cleanAgentRetention(token)
      if (!current()) return
      setNotice(
        `已清理 ${result.deletedBatches} 个批次，释放 ${(result.freedBytes / 1024 / 1024).toFixed(2)} MB。`,
      )
      onCleaned()
    } catch (cause) {
      if (current()) setError(`${agentError(cause)} 请重新预览后核对。`)
    } finally {
      if (current()) {
        setPreview(null)
        setConfirm(false)
        setBusy(false)
      }
    }
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) onClose()
        }}
      >
        <DialogContent className="sales-agent-dialog" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>清理已结束任务</DialogTitle>
            <DialogDescription>
              先预览符合保留策略的任务，再明确确认。未知动作、记录待同步、占用中的资源及商品发布事实始终受保护。
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="agent-clean-days">保留最近天数</FieldLabel>
            <Input
              id="agent-clean-days"
              type="number"
              min={1}
              max={3650}
              value={Number.isFinite(days) ? days : ''}
              disabled={busy}
              onChange={(event) => {
                setDays(event.target.valueAsNumber)
                setPreview(null)
              }}
            />
          </Field>
          <div className="sales-agent-toolbar">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void inspect()}
            >
              {busy ? '处理中…' : '预览可清理任务'}
            </Button>
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {notice ? <p role="status">{notice}</p> : null}
          {preview ? (
            <>
              <dl className="sales-agent-metrics">
                <div>
                  <dt>可清理批次</dt>
                  <dd>{preview.batches}</dd>
                </div>
                <div>
                  <dt>受保护批次</dt>
                  <dd>{preview.protected}</dd>
                </div>
                <div>
                  <dt>可释放附件</dt>
                  <dd>{(preview.artifactBytes / 1024 / 1024).toFixed(2)} MB</dd>
                </div>
              </dl>
              <p className="sales-agent-control-help">
                早于 {new Date(preview.before).toLocaleString()}{' '}
                的符合条件记录。确认时会再次核对保护条件。
              </p>
              <Button
                variant="destructive"
                disabled={busy || preview.batches === 0}
                onClick={() => setConfirm(true)}
              >
                清理预览中的任务
              </Button>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={confirm}
        onOpenChange={(open) => {
          if (!busy) setConfirm(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              确认清理 {preview?.batches ?? 0} 个已结束批次？
            </AlertDialogTitle>
            <AlertDialogDescription>
              此操作删除符合条件的任务历史和可清理附件，无法撤销。保留{' '}
              {preview?.protected ?? 0} 个受保护批次及商品发布事实。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>返回</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !preview}
              onClick={(event) => {
                event.preventDefault()
                void clean()
              }}
            >
              {busy ? '清理中…' : '确认清理'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
