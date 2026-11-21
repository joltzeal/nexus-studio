import { useEffect, useRef, useState } from 'react'
import { ScanSearch } from '@/components/icons'
import type { AgentBatchCreate } from '@nexus/plugin-sdk/agent'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { toast } from '@/components/ui/toast'
import { agentError, createAgentBatch } from '@/features/sales-agent/api'
import { navigateDetail } from '@/lib/detail-navigation'
import { listBindings } from './api'
import type { Binding } from './types'

export function AccountInspectionAction({
  accountId,
  accountName,
  bindings,
}: {
  accountId: string
  accountName: string
  bindings: readonly Binding[]
}) {
  const [open, setOpen] = useState(false)
  const [selectedWindowId, setSelectedWindowId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [hasRequest, setHasRequest] = useState(false)
  const submission = useRef<{
    input: AgentBatchCreate
    binding: Binding
  } | null>(null)
  const inFlight = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const accountBindings = bindings.filter((binding) => binding.accountId === accountId)
  const selected = accountBindings.find(
    (binding) => binding.windowId === selectedWindowId,
  )
  const locked = busy || hasRequest || createdId !== null

  function changeOpen(next: boolean) {
    if (inFlight.current) return
    if (!next && createdId) {
      submission.current = null
      setHasRequest(false)
      setCreatedId(null)
      setError(null)
    }
    if (next && !submission.current) {
      setSelectedWindowId(accountBindings[0]?.windowId ?? '')
      setError(null)
    }
    setOpen(next)
  }

  async function submit() {
    if (!open || inFlight.current || createdId || !selected) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const expected = submission.current?.binding ?? selected
      const matches = (binding: Binding) =>
        binding.windowId === expected.windowId &&
        binding.accountId === accountId &&
        binding.revision === expected.revision &&
        binding.boundAt === expected.boundAt
      const fresh = await listBindings()
      if (!active.current) return
      const candidates = Array.isArray(fresh?.items)
        ? fresh.items.filter((binding) => binding?.windowId === expected.windowId)
        : []
      const current = candidates[0]
      if (
        !expected.revision ||
        !matches(selected) ||
        candidates.length !== 1 ||
        !current ||
        !matches(current) ||
        current.account?.id !== accountId
      )
        throw new Error('账号与所选窗口的关联已变化或不可见，请刷新账号池后核对。')
      const request = submission.current ?? {
        input: {
          operationId: crypto.randomUUID(),
          preset: 'inspect_accounts' as const,
          instruction: '',
          concurrency: 1,
          assignments: [
            { windowId: expected.windowId, productIds: [], overrides: [], messages: [] },
          ],
        },
        binding: { ...expected },
      }
      // Keep the exact request even if native creation succeeded but its reply was lost.
      submission.current = request
      setHasRequest(true)
      const batch = await createAgentBatch(request.input)
      if (!active.current) return
      setCreatedId(batch.id)
      toast.success('账号检查任务已创建')
    } catch (cause) {
      if (active.current) setError(agentError(cause))
    } finally {
      inFlight.current = false
      if (active.current) setBusy(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`检查 ${accountName}`}
        title="检查账号"
        onClick={() => changeOpen(true)}
      >
        <ScanSearch data-icon="inline-start" />
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>检查账号</DialogTitle>
            <DialogDescription>
              通过已启用的 Ecom Agent 只读检查账号状态、主页、余额、收款信息和画像。
              必要时会启动所选窗口，忙碌窗口会排队。
            </DialogDescription>
          </DialogHeader>
          <p className="truncate" title={accountName}>
            {accountName}
          </p>
          {accountBindings.length ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`account-inspection-${accountId}`}>
                  关联窗口
                </FieldLabel>
                <LabeledSelect
                  id={`account-inspection-${accountId}`}
                  ariaLabel="检查窗口"
                  value={selectedWindowId}
                  options={accountBindings.map((binding) => ({
                    value: binding.windowId,
                    label: binding.windowId,
                  }))}
                  disabled={locked}
                  onValueChange={(value) => {
                    if (
                      !locked &&
                      accountBindings.some((binding) => binding.windowId === value)
                    )
                      setSelectedWindowId(value)
                  }}
                />
              </Field>
            </FieldGroup>
          ) : (
            <p className="text-sm text-muted-foreground">
              该账号尚未关联窗口，请先在窗口管理关联已有窗口。
            </p>
          )}
          {error ? <FieldError role="alert">{error}</FieldError> : null}
          {hasRequest && !busy && !createdId ? (
            <p className="text-sm text-muted-foreground" role="status">
              创建结果未确认，请先查看执行记录核对；核对原创建请求会沿用同一操作标识。
            </p>
          ) : null}
          {createdId ? (
            <p className="text-sm text-muted-foreground" role="status">
              检查任务已创建，可在执行记录查看进度和结果。
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => changeOpen(false)}>
              关闭
            </Button>
            {createdId ? (
              <Button
                onClick={() => {
                  navigateDetail({ kind: 'agent', id: createdId, batchId: createdId })
                  changeOpen(false)
                }}
              >
                查看任务
              </Button>
            ) : (
              <>
                {hasRequest ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      navigateDetail({ kind: 'agent', id: accountId, related: 'account' })
                    }
                  >
                    查看执行记录
                  </Button>
                ) : null}
                <Button disabled={busy || !selected} onClick={() => void submit()}>
                  {busy ? '正在创建…' : hasRequest ? '核对原创建请求' : '创建检查任务'}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
