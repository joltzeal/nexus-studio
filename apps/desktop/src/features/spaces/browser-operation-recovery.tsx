import { useEffect, useRef, useState } from 'react'
import type {
  BrowserOperation,
  BrowserProviderId,
  BrowserWindow,
  RemoteProfile,
  ResolveBrowserOperationInput,
} from '@nexus/contracts/browser'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { browserError } from '@/lib/platform/browser-api'
import { discoverBrowserProfiles } from '@/lib/platform/browser-connections'
import {
  listBrowserOperations,
  reconcileBrowserOperation,
  resolveBrowserOperation,
} from '@/lib/platform/windows'

const operationLabels: Record<string, string> = {
  create: '创建窗口',
  update: '修改窗口',
  delete: '删除窗口',
  start: '启动窗口',
  stop: '停止窗口',
  attach: '接入窗口',
}
const phaseLabels: Record<string, string> = {
  prepared: '等待提交',
  submitted: '已提交，等待确认',
  confirmed: '已确认，等待保存',
  uncertain: '结果待核对',
}

function canResolveManually(operation: BrowserOperation, providerId: BrowserProviderId) {
  if (operation.phase !== 'submitted' && operation.phase !== 'uncertain') return false
  return providerId === 'cloakbrowser'
    ? operation.kind === 'start' || operation.kind === 'stop'
    : ['create', 'start', 'stop', 'update', 'delete'].includes(operation.kind)
}

export function BrowserOperationRecovery({
  connectionId,
  providerId,
  refreshKey,
  onRecovered,
}: {
  connectionId: string | null
  providerId: BrowserProviderId
  refreshKey: number
  onRecovered: (window: BrowserWindow | null) => void
}) {
  const scope = `${connectionId ?? ''}:${providerId}`
  const [snapshot, setSnapshot] = useState<{
    scope: string
    request: number
    operations: BrowserOperation[]
  } | null>(null)
  const [manual, setManual] = useState<{
    scope: string
    request: number
    id: string
  } | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<{ scope: string; message: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const generation = useRef(0)
  const busy = useRef(false)
  useEffect(() => {
    const request = ++generation.current
    if (connectionId === null) return
    void listBrowserOperations(connectionId).then(
      (items) => {
        if (request !== generation.current) return
        setSnapshot({
          scope,
          request,
          operations: items.filter(
            (item) =>
              item.connectionId === connectionId &&
              !['failed', 'committed', 'cancelled'].includes(item.phase),
          ),
        })
        setError(null)
      },
      (cause: unknown) => {
        if (request === generation.current)
          setError({ scope, message: browserError(cause).message })
      },
    )
    return () => {
      generation.current += 1
    }
  }, [connectionId, providerId, scope, refreshKey, attempt])
  const operations = snapshot?.scope === scope ? snapshot.operations : []
  const visibleError = error?.scope === scope ? error.message : null
  const manualOperation =
    manual?.scope === scope && manual.request === snapshot?.request
      ? (operations.find(
          (operation) =>
            operation.id === manual.id && canResolveManually(operation, providerId),
        ) ?? null)
      : null
  async function reconcile(id: string) {
    if (busy.current) return
    const request = generation.current
    busy.current = true
    setPending(id)
    try {
      const window = await reconcileBrowserOperation(id)
      if (request !== generation.current) return
      setError(null)
      onRecovered(window)
      setAttempt((value) => value + 1)
    } catch (cause) {
      if (request === generation.current)
        setError({ scope, message: browserError(cause).message })
    } finally {
      busy.current = false
      setPending(null)
    }
  }
  function resolvedManually(window: BrowserWindow | null) {
    if (manual?.scope !== scope || manual.request !== generation.current) return
    setError(null)
    onRecovered(window)
    setManual(null)
    setAttempt((value) => value + 1)
  }
  if (operations.length === 0 && !visibleError) return null
  return (
    <div className="grid gap-2 rounded-lg border p-3" aria-label="待核对浏览器操作">
      {operations.map((operation) => (
        <div key={operation.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            {operationLabels[operation.kind] ?? '浏览器操作'} ·{' '}
            {phaseLabels[operation.phase] ?? '待核对'} ·{' '}
            {operation.message ?? '结果尚未确认'}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void reconcile(operation.id)}
          >
            {pending === operation.id ? '正在核对…' : '重新核对操作'}
          </Button>
          {canResolveManually(operation, providerId) ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending !== null}
              onClick={() => {
                if (busy.current) return
                setError(null)
                setManual({ scope, request: generation.current, id: operation.id })
              }}
            >
              手动处理
            </Button>
          ) : null}
        </div>
      ))}
      {visibleError ? (
        <FieldError role="alert">
          {visibleError}
          <Button
            variant="link"
            size="sm"
            disabled={pending !== null}
            onClick={() => setAttempt((value) => value + 1)}
          >
            刷新操作记录
          </Button>
        </FieldError>
      ) : null}
      {manualOperation && connectionId ? (
        <BrowserOperationResolutionDialog
          key={`${scope}:${manualOperation.id}:${manual?.request}`}
          connectionId={connectionId}
          providerId={providerId}
          operation={manualOperation}
          onResolved={resolvedManually}
          onClose={() => {
            if (manual?.request === generation.current) setManual(null)
          }}
        />
      ) : null}
    </div>
  )
}

export function BrowserOperationResolutionDialog({
  connectionId,
  providerId,
  operation,
  onResolved,
  onClose,
}: {
  connectionId: string
  providerId: BrowserProviderId
  operation: BrowserOperation
  onResolved: (window: BrowserWindow | null) => void
  onClose: () => void
}) {
  const eligible =
    operation.connectionId === connectionId && canResolveManually(operation, providerId)
  const canAssociate =
    eligible && providerId !== 'cloakbrowser' && operation.kind === 'create'
  const [choice, setChoice] = useState<'associate' | 'abandon'>(
    canAssociate ? 'associate' : 'abandon',
  )
  const action = canAssociate ? choice : 'abandon'
  const scope = `${connectionId}:${providerId}:${operation.id}`
  const [attempt, setAttempt] = useState(0)
  const loadKey = `${scope}:${attempt}`
  const [discovered, setDiscovered] = useState<{
    key: string
    profiles: RemoteProfile[]
    error: string | null
  } | null>(null)
  const [selection, setSelection] = useState<{ key: string; id: string } | null>(null)
  const profiles = discovered?.key === loadKey ? discovered.profiles : []
  const selected =
    selection?.key === loadKey
      ? (profiles.find((profile) => profile.id === selection.id) ?? null)
      : null
  const confirmationKey = `${loadKey}:${action}:${selected?.id ?? ''}`
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null)
  const confirmed = confirmedKey === confirmationKey
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<{ scope: string; message: string } | null>(null)
  const busy = useRef(false)
  const generation = useRef(0)
  const discovering = canAssociate && action === 'associate'
  const loading = discovering && discovered?.key !== loadKey
  const discoveryError = discovered?.key === loadKey ? discovered.error : null
  const visibleError = error?.scope === scope ? error.message : null
  useEffect(() => {
    generation.current += 1
    return () => {
      generation.current += 1
    }
  }, [scope, operation.kind, operation.phase])
  useEffect(() => {
    if (!discovering) return
    let active = true
    void discoverBrowserProfiles(connectionId).then(
      (items) => {
        if (active) setDiscovered({ key: loadKey, profiles: items, error: null })
      },
      (cause: unknown) => {
        if (active)
          setDiscovered({
            key: loadKey,
            profiles: [],
            error: browserError(cause).message,
          })
      },
    )
    return () => {
      active = false
    }
  }, [connectionId, discovering, loadKey])

  async function submit() {
    if (
      busy.current ||
      !eligible ||
      !confirmed ||
      (action === 'associate' && (!selected || loading || discoveryError))
    )
      return
    const input: ResolveBrowserOperationInput =
      action === 'associate' && selected
        ? {
            id: operation.id,
            action: 'associate',
            providerProfileId: selected.id,
            confirmed: true,
          }
        : { id: operation.id, action: 'abandon', confirmed: true }
    const request = generation.current
    busy.current = true
    setPending(true)
    setError(null)
    try {
      const window = await resolveBrowserOperation(input)
      if (request !== generation.current) return
      if (
        input.action === 'associate' &&
        (!window ||
          window.id !== operation.windowId ||
          window.connectionId !== connectionId ||
          window.providerId !== providerId ||
          window.providerProfileId !== input.providerProfileId ||
          window.proxyMode !== 'provider')
      )
        throw new Error('关联结果与保留的窗口或所选官方环境不符，请重新核对操作。')
      onResolved(window)
    } catch (cause) {
      if (request === generation.current)
        setError({ scope, message: browserError(cause).message })
    } finally {
      busy.current = false
      if (request === generation.current) setPending(false)
    }
  }
  function close() {
    if (!busy.current) onClose()
  }

  if (!eligible) return null
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        className="window-editor"
        showCloseButton={!pending}
        onEscapeKeyDown={(event) => {
          if (busy.current) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (busy.current) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>手动处理浏览器操作</DialogTitle>
          <DialogDescription>
            {operationLabels[operation.kind]}结果尚未确认，请先在
            {providerId === 'cloakbrowser' ? '浏览器中' : '官方应用中'}核对实际结果。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <p className="break-all text-xs text-muted-foreground">
            操作 UUID：{operation.id}
          </p>
          {canAssociate ? (
            <Field>
              <FieldLabel>处理方式</FieldLabel>
              <Select
                value={action}
                disabled={pending}
                onValueChange={(value) => {
                  if (busy.current || (value !== 'associate' && value !== 'abandon'))
                    return
                  setChoice(value)
                  setSelection(null)
                  setConfirmedKey(null)
                  setError(null)
                  if (value === 'associate') setAttempt((current) => current + 1)
                }}
              >
                <SelectTrigger aria-label="处理方式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="associate">关联已核对的官方环境</SelectItem>
                  <SelectItem value="abandon">放弃此操作</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {action === 'associate' ? (
            <>
              <p>
                关联将保留窗口 UUID：{operation.windowId}，采用所选官方环境的当前配置，
                代理来源为「沿用浏览器设置（Provider）」。请根据环境 ID
                在官方应用核对选择。
              </p>
              <Field>
                <FieldLabel>官方环境</FieldLabel>
                <Select
                  value={selected?.id ?? ''}
                  disabled={pending || loading || profiles.length === 0}
                  onValueChange={(id) => {
                    if (busy.current) return
                    setSelection({ key: loadKey, id })
                    setConfirmedKey(null)
                    setError(null)
                  }}
                >
                  <SelectTrigger aria-label="选择官方环境">
                    <SelectValue placeholder="选择已在官方应用核对的环境" />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.name || '未命名环境'} · {profile.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {loading ? <p role="status">正在读取官方环境…</p> : null}
              {!loading && !discoveryError && profiles.length === 0 ? (
                <p role="status">没有可选择的官方环境，请核对当前账户或重新读取。</p>
              ) : null}
              {discoveryError ? (
                <FieldError role="alert">{discoveryError}</FieldError>
              ) : null}
              <Button
                variant="outline"
                disabled={pending || loading}
                onClick={() => {
                  if (busy.current) return
                  setSelection(null)
                  setConfirmedKey(null)
                  setError(null)
                  setAttempt((value) => value + 1)
                }}
              >
                重新读取环境
              </Button>
            </>
          ) : (
            <>
              <p>
                放弃会永久结束此操作，原操作不能自动重试。不会发送浏览器写入或删除请求。
                如需再次操作，须另行发起新操作。
              </p>
              {operation.kind !== 'create' ? (
                <p>系统会重新核对当前状态；状态未知时可能拒绝放弃。</p>
              ) : null}
              {operation.kind === 'update' ? (
                <p>放弃修改将重新采用官方环境的当前设置，避免继续使用旧代理配置。</p>
              ) : null}
            </>
          )}
          <Field orientation="horizontal">
            <Checkbox
              id={`resolve-confirm-${operation.id}`}
              checked={confirmed}
              disabled={pending || (action === 'associate' && (!selected || loading))}
              onCheckedChange={(checked) => {
                if (!busy.current)
                  setConfirmedKey(checked === true ? confirmationKey : null)
              }}
            />
            <FieldLabel htmlFor={`resolve-confirm-${operation.id}`}>
              {action === 'associate'
                ? '我已在官方应用核对所选环境，确认将其关联到保留的窗口 UUID。'
                : providerId === 'cloakbrowser'
                  ? '我已核对浏览器的实际状态和操作结果，确认放弃此操作。'
                  : '我已在官方应用核对操作结果，确认放弃此操作。'}
            </FieldLabel>
          </Field>
          {visibleError ? <FieldError role="alert">{visibleError}</FieldError> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={close}>
            取消
          </Button>
          <Button
            disabled={
              pending ||
              !confirmed ||
              (action === 'associate' && (!selected || loading || !!discoveryError))
            }
            onClick={() => void submit()}
          >
            {pending ? '正在处理…' : '确认处理'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
