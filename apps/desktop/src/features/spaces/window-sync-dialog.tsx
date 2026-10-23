import { useEffect, useRef, useState } from 'react'
import { Copy, Loader2, RefreshCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { toast } from '@/components/ui/toast'
import { listPlugins, type PluginView } from '@/lib/platform/native-plugins'
import type { NativeProfile } from '@/lib/platform/native-profiles'
import {
  cancelWindowSync,
  importWindowSync,
  offerWindowSync,
  receiveWindowSync,
  transferError,
  windowSyncStatus,
  type ImportMode,
  type SyncOffer,
  type SyncStatus,
  type TransferReport,
} from '@/lib/platform/native-transfer'
import { ImportModeField, TransferResult, TransferWarnings } from './transfer-feedback'
import {
  canImportReceived,
  selectionError,
  watchSyncStatus,
  withDeadline,
} from './transfer-state'

interface SyncSession {
  id: string
  direction: 'send' | 'receive'
  offer?: SyncOffer
}

function expiryLabel(value: number): string {
  const date = new Date(value)
  return date.toLocaleString()
}

export function WindowSyncDialog({
  open,
  windows,
  operating,
  onImported,
  onClose,
}: {
  open: boolean
  windows: NativeProfile[]
  operating: ReadonlySet<string>
  onImported: () => Promise<void>
  onClose: () => void
}) {
  const [direction, setDirection] = useState<'send' | 'receive'>('send')
  const [invitation, setInvitation] = useState('')
  const [host, setHost] = useState('')
  const [plugin, setPlugin] = useState<PluginView | null>(null)
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [session, setSession] = useState<SyncSession | null>(null)
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [pollRevision, setPollRevision] = useState(0)
  const [mode, setMode] = useState<ImportMode>('copy')
  const [report, setReport] = useState<TransferReport | null>(null)
  const [cancelAcknowledged, setCancelAcknowledged] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const installed = catalogLoaded && plugin !== null && plugin.state !== 'available'
  const issue = selectionError(windows, operating)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void withDeadline(
      listPlugins(),
      10_000,
      '读取同步插件超时，请检查插件中心后重试。',
      controller.signal,
    ).then(
      (catalog) => {
        if (controller.signal.aborted) return
        setPlugin(catalog.find((entry) => entry.id === 'studio.window-sync') ?? null)
        setCatalogError(null)
        setCatalogLoaded(true)
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setPlugin(null)
          setCatalogError(transferError(cause))
          setCatalogLoaded(true)
        }
      },
    )
    return () => controller.abort()
  }, [open, catalogRevision])

  const sessionId = session?.id
  useEffect(() => {
    if (!open || sessionId === undefined || cancelAcknowledged) return
    return watchSyncStatus(
      () => windowSyncStatus(sessionId),
      (next) => {
        setStatus(next)
        setPollError(null)
      },
      (cause) => setPollError(transferError(cause)),
    )
  }, [open, sessionId, pollRevision, cancelAcknowledged])

  async function run(label: string, operation: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(label)
    setError(null)
    try {
      await operation()
    } catch (cause) {
      if (mounted.current) setError(transferError(cause))
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(null)
    }
  }

  function start() {
    if (!installed) return
    if (direction === 'send' && issue !== null) {
      setError(issue)
      return
    }
    if (direction === 'receive' && !invitation.trim()) {
      setError('请粘贴发送设备生成的完整配对邀请。')
      return
    }
    void run(
      direction === 'send' ? '正在准备加密快照和配对邀请…' : '正在连接发送设备…',
      async () => {
        const next: SyncSession =
          direction === 'send'
            ? await offerWindowSync(windows.map((window) => window.id)).then((offer) => ({
                id: offer.offerId,
                direction: 'send',
                offer,
              }))
            : await receiveWindowSync(invitation.trim(), host).then((job) => ({
                id: job.jobId,
                direction: 'receive',
              }))
        if (!mounted.current) return
        setSession(next)
        setStatus(null)
        setPollError(null)
        setReport(null)
        setCancelAcknowledged(false)
        setMode('copy')
        setInvitation('')
      },
    )
  }

  function cancel() {
    if (session === null) return
    void run('正在请求取消同步…', async () => {
      await cancelWindowSync(session.id)
      if (mounted.current) {
        setCancelAcknowledged(true)
        setPollError(null)
      }
    })
  }

  function confirmImport() {
    if (
      session === null ||
      !canImportReceived(session.direction, status, report !== null, cancelAcknowledged)
    )
      return
    void run('正在导入接收的快照…', async () => {
      const result = await importWindowSync(session.id, mode)
      if (!mounted.current) return
      setReport(result)
      try {
        await onImported()
      } catch (cause) {
        if (mounted.current) {
          setError(
            `窗口已导入，但列表刷新失败：${transferError(cause)}。请关闭弹窗后刷新列表。`,
          )
        }
      }
    })
  }

  function reset() {
    setSession(null)
    setStatus(null)
    setPollError(null)
    setReport(null)
    setCancelAcknowledged(false)
    setError(null)
    setMode('copy')
    setHost('')
  }

  async function copyInvitation(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      toast.success('已复制配对邀请')
    } catch {
      toast.error('复制失败，请手动选择并复制配对邀请。')
    }
  }

  const terminal =
    cancelAcknowledged ||
    (status !== null && status.state !== 'waiting' && status.state !== 'transferring')
  const receivingComplete =
    session !== null &&
    canImportReceived(session.direction, status, report !== null, cancelAcknowledged)
  const statusLabel = cancelAcknowledged
    ? '取消请求已完成，本次任务不会再导入。'
    : pollError
      ? '同步状态尚未确认；下方为上次读取的进度。'
      : status === null
        ? '正在读取真实同步状态…'
        : status.state === 'waiting'
          ? '等待另一台设备配对'
          : status.state === 'transferring'
            ? '正在传输加密快照'
            : status.state === 'completed'
              ? session?.direction === 'receive'
                ? '快照接收完成，等待导入'
                : '快照发送完成，接收设备仍需显式导入'
              : status.state === 'cancelled'
                ? '同步已取消'
                : '同步失败'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !inFlight.current) onClose()
      }}
    >
      <DialogContent className="sm:max-w-xl" showCloseButton={busy === null}>
        <DialogHeader>
          <DialogTitle>设备同步</DialogTitle>
          <DialogDescription>
            通过可直连的设备地址传输加密快照。A / B
            两端各自保有独立副本；后续修改不会实时合并。 自动穿透与中继尚未接入。
          </DialogDescription>
        </DialogHeader>
        {session === null ? (
          <>
            {!catalogLoaded ? (
              <p role="status">正在检查设备同步插件…</p>
            ) : !installed ? (
              <Alert>
                <AlertTitle>需要安装设备同步插件</AlertTitle>
                <AlertDescription>
                  请在「插件中心」安装 studio.window-sync 后重试。
                  {catalogError ? ` ${catalogError}` : ''}
                </AlertDescription>
              </Alert>
            ) : plugin?.lastError ? (
              <FieldError>{plugin.lastError}</FieldError>
            ) : null}
            <Button
              variant="outline"
              disabled={busy !== null || !catalogLoaded}
              onClick={() => {
                setCatalogLoaded(false)
                setCatalogRevision((value) => value + 1)
              }}
            >
              <RefreshCw data-icon="inline-start" />
              重新检查插件
            </Button>
            <ToggleGroup
              type="single"
              variant="outline"
              value={direction}
              disabled={busy !== null}
              onValueChange={(value) => {
                if (value === 'send' || value === 'receive') {
                  setDirection(value)
                  setError(null)
                }
              }}
              aria-label="同步方向"
            >
              <ToggleGroupItem value="send">发送窗口</ToggleGroupItem>
              <ToggleGroupItem value="receive">接收窗口</ToggleGroupItem>
            </ToggleGroup>
            {direction === 'send' ? (
              <div className="flex flex-col gap-3">
                <p>已选择 {windows.length} 个窗口。发送前必须全部关闭。</p>
                {issue ? <FieldError>{issue}</FieldError> : null}
                {windows.some((window) => window.settings.fingerprintSeed === null) ? (
                  <TransferWarnings
                    warnings={['部分旧窗口未固定指纹种子，迁移后不能保证指纹完全一致。']}
                  />
                ) : null}
              </div>
            ) : (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="sync-invitation-input">配对邀请</FieldLabel>
                  <Textarea
                    id="sync-invitation-input"
                    autoComplete="off"
                    spellCheck={false}
                    rows={3}
                    disabled={busy !== null}
                    value={invitation}
                    onChange={(event) => setInvitation(event.target.value)}
                    placeholder="粘贴发送设备的完整配对邀请"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="sync-host">发送设备地址（可选）</FieldLabel>
                  <Input
                    id="sync-host"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy !== null}
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                    placeholder="例如 192.168.1.10"
                  />
                  <FieldDescription>
                    留空使用邀请中的地址。只填写 IP
                    或主机名，不带端口；端口由配对邀请提供。
                  </FieldDescription>
                </Field>
              </FieldGroup>
            )}
          </>
        ) : (
          <div className="flex min-w-0 flex-col gap-4">
            {session.offer ? (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="sync-invitation-output">配对邀请</FieldLabel>
                  <Textarea
                    id="sync-invitation-output"
                    readOnly
                    rows={3}
                    value={session.offer.invitation}
                  />
                  <Button
                    variant="outline"
                    onClick={() => void copyInvitation(session.offer!.invitation)}
                  >
                    <Copy data-icon="inline-start" />
                    复制配对邀请
                  </Button>
                  <FieldDescription>
                    仅发送给接收设备，有效期至 {expiryLabel(session.offer.expiresAt)}。
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>发送设备地址</FieldLabel>
                  <p className="break-all">
                    {session.offer.addresses.join('、') ||
                      '未发现可用地址，请检查本机网络。'}
                  </p>
                </Field>
              </FieldGroup>
            ) : null}
            <p className="break-all text-muted-foreground">任务：{session.id}</p>
            {report === null ? (
              <div className="flex flex-col gap-2">
                <p role="status" aria-live="polite">
                  {statusLabel}
                </p>
                {!cancelAcknowledged &&
                status &&
                (status.state === 'transferring' || status.state === 'waiting') ? (
                  <progress
                    aria-label="快照传输进度"
                    className="h-2 w-full accent-primary"
                    max={status.total || undefined}
                    value={status.total ? status.bytes : undefined}
                  />
                ) : null}
                {status ? (
                  <p className="text-muted-foreground">
                    {status.bytes.toLocaleString()} /{' '}
                    {status.total ? status.total.toLocaleString() : '未知'} 字节
                  </p>
                ) : null}
                {status?.state === 'failed' ? (
                  <FieldError>
                    {status.error ??
                      '同步失败，请检查配对邀请是否过期及两端网络是否可达。'}
                  </FieldError>
                ) : null}
              </div>
            ) : (
              <TransferResult report={report} action="导入" />
            )}
            {pollError ? (
              <>
                <FieldError>{pollError}</FieldError>
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => setPollRevision((value) => value + 1)}
                >
                  <RefreshCw data-icon="inline-start" />
                  重试读取状态
                </Button>
              </>
            ) : null}
            {receivingComplete ? (
              <ImportModeField
                sync
                mode={mode}
                disabled={busy !== null}
                onChange={setMode}
              />
            ) : null}
            {!terminal ? (
              <p className="text-muted-foreground">
                收起弹窗会保留原生任务；只有「取消同步」会请求取消。
              </p>
            ) : null}
          </div>
        )}
        {busy ? (
          <p role="status" className="text-muted-foreground">
            {busy}
          </p>
        ) : null}
        {error ? <FieldError>{error}</FieldError> : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy !== null} onClick={onClose}>
            {session && !terminal ? '收起' : '关闭'}
          </Button>
          {session === null ? (
            <Button
              disabled={
                busy !== null ||
                !installed ||
                (direction === 'send' ? issue !== null : !invitation.trim())
              }
              onClick={start}
            >
              {busy ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : null}
              {direction === 'send' ? '生成配对邀请' : '连接并接收'}
            </Button>
          ) : !terminal ? (
            <Button variant="destructive" disabled={busy !== null} onClick={cancel}>
              取消同步
            </Button>
          ) : receivingComplete ? (
            <Button
              variant={mode === 'replace' ? 'destructive' : 'default'}
              disabled={busy !== null}
              onClick={confirmImport}
            >
              {mode === 'replace' ? '覆盖导入接收快照' : '导入接收窗口'}
            </Button>
          ) : (
            <Button disabled={busy !== null} onClick={reset}>
              开始新的同步
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
