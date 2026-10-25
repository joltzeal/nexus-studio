import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
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
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from '@/components/ui/toast'
import { bindAccount, listAccounts } from '@/features/accounts/api'
import { listGroups, type WindowGroup } from '@/lib/platform/native-groups'
import { getLicenseStatus, type LicenseStatus } from '@/lib/platform/native-license'
import {
  createNativeProfile,
  listNativeProfiles,
  type NativeProfile,
} from '@/lib/platform/native-profiles'
import { withDeadline } from './transfer-state'
import { WindowBatchJob, type BatchAccount, type WindowBatchItem } from './window-batch'
import { WindowEditor, type SaveWindow } from './window-editor'

interface BatchContext {
  profiles: NativeProfile[]
  groups: WindowGroup[]
  license: LicenseStatus
  boundAccountIds: Set<string>
}

interface BatchWindowDialogProps {
  accounts?: readonly BatchAccount[]
  onClose: () => void
  onSettled: (items: readonly WindowBatchItem[]) => void | Promise<void>
}

function message(cause: unknown): string {
  return typeof cause === 'string'
    ? cause
    : cause instanceof Error
      ? cause.message
      : '操作失败，请重试。'
}

async function accountBindings(
  selected: readonly BatchAccount[] | undefined,
): Promise<Set<string>> {
  if (!selected) return new Set()
  const data = await listAccounts()
  const available = new Set(data.items.map((account) => account.id))
  if (selected.some((account) => !available.has(account.id))) {
    throw new Error('部分所选账号已被删除，请关闭弹窗并刷新账号列表。')
  }
  return new Set(data.bindings.map((binding) => binding.accountId))
}

export function BatchWindowDialog({
  accounts,
  onClose,
  onSettled,
}: BatchWindowDialogProps) {
  const [context, setContext] = useState<BatchContext | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [count, setCount] = useState(accounts?.length ?? 10)
  const [allowExisting, setAllowExisting] = useState(false)
  const [confirmConflicts, setConfirmConflicts] = useState(false)
  const [items, setItems] = useState<readonly WindowBatchItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const job = useRef<WindowBatchJob | null>(null)
  const running = useRef(false)
  const mounted = useRef(true)
  const confirmedAccounts = useRef(new Set<string>())

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      job.current?.stopAfterCurrent()
    }
  }, [])

  useEffect(() => {
    let active = true
    void withDeadline(
      Promise.all([
        listNativeProfiles(),
        listGroups(),
        getLicenseStatus(),
        accountBindings(accounts),
      ]),
      10_000,
      '读取创建配置超时，请重试。',
    ).then(
      ([profiles, groups, license, boundAccountIds]) => {
        if (active) {
          setContext({ profiles, groups, license, boundAccountIds })
          setLoadError(null)
        }
      },
      (cause: unknown) => {
        if (active) setLoadError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [accounts, loadAttempt])

  const alreadyBound =
    accounts?.filter((account) => context?.boundAccountIds.has(account.id)) ?? []
  const conflicts =
    items?.filter(
      (item) => item.status === 'failed' && item.duplicateWindowIds.length > 0,
    ) ?? []
  const completed = items?.filter((item) => item.status === 'complete').length ?? 0
  const failed = items?.filter((item) => item.status === 'failed').length ?? 0
  const pending = items?.filter((item) => item.status === 'pending').length ?? 0

  async function run(current: WindowBatchJob) {
    if (running.current) return
    running.current = true
    setBusy(true)
    setStopping(false)
    setRefreshError(null)
    try {
      await current.run((next) => {
        if (mounted.current) setItems(next)
      }, confirmedAccounts.current)
      if (!mounted.current) return
      const successes = current.items.filter((item) => item.status === 'complete').length
      if (successes === current.items.length) {
        toast.success(`已创建 ${successes} 个窗口${accounts ? '并关联账号' : ''}`)
      }
      // Refresh is separate from native creation and binding. Its failure must
      // never turn a completed item into another create attempt.
      try {
        await withDeadline(
          Promise.resolve(onSettled(current.items)),
          10_000,
          '读取列表超时，请稍后刷新。',
        )
      } catch (cause) {
        if (mounted.current) {
          setRefreshError(`创建结果已保留，列表刷新失败：${message(cause)}`)
        }
      }
    } finally {
      running.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const start: SaveWindow = async (
    namePrefix,
    proxy,
    proxyPlugin,
    proxyEndpoint,
    settings,
    groupId,
  ) => {
    if (running.current || job.current) return
    const confirmed = new Set(
      allowExisting ? alreadyBound.map((account) => account.id) : [],
    )
    const [profiles, boundAccountIds] = await withDeadline(
      Promise.all([listNativeProfiles(), accountBindings(accounts)]),
      10_000,
      '核对窗口和账号超时，请重试。',
    )
    const unconfirmed =
      accounts?.filter(
        (account) => boundAccountIds.has(account.id) && !confirmed.has(account.id),
      ) ?? []
    if (unconfirmed.length) {
      setContext((current) => (current ? { ...current, boundAccountIds } : current))
      setAllowExisting(false)
      throw new Error('部分账号已有窗口关联，请勾选账号确认项后再创建。')
    }
    confirmedAccounts.current = confirmed
    const next = new WindowBatchJob(
      {
        count,
        namePrefix,
        ...(accounts ? { accounts } : {}),
        proxy: { proxy, proxyPlugin, proxyEndpoint },
        settings,
        groupId: groupId ?? null,
      },
      profiles,
      {
        createProfile: createNativeProfile,
        listProfiles: () =>
          withDeadline(listNativeProfiles(), 10_000, '核对已创建窗口超时，请重试。'),
        bindAccount,
      },
    )
    job.current = next
    setItems(next.items)
    await run(next)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running.current) onClose()
      }}
    >
      {items ? (
        <DialogContent
          className="window-editor"
          showCloseButton={!busy}
          onEscapeKeyDown={(event) => {
            if (running.current) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (running.current) event.preventDefault()
          }}
        >
          <DialogHeader>
            <DialogTitle>批量创建窗口</DialogTitle>
            <DialogDescription aria-live="polite" role="status">
              已完成 {completed}/{items.length}
              {failed ? ` · 未完成 ${failed}` : ''}
              {pending ? ` · 待处理 ${pending}` : ''}
              {stopping && busy ? ' · 正在完成当前项' : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="window-form flex flex-col gap-3">
            <Table aria-label="批量创建结果">
              <TableHeader>
                <TableRow>
                  <TableHead>窗口</TableHead>
                  {accounts ? <TableHead>账号</TableHead> : null}
                  <TableHead>指纹种子</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.key}>
                    <TableCell className="max-w-56">
                      <span className="block truncate" title={item.name}>
                        {item.name}
                      </span>
                      {item.error ? (
                        <FieldError className="whitespace-normal wrap-anywhere">
                          {item.error}
                        </FieldError>
                      ) : null}
                    </TableCell>
                    {accounts ? (
                      <TableCell className="max-w-40">
                        <span className="block truncate" title={item.account?.label}>
                          {item.account?.label}
                        </span>
                      </TableCell>
                    ) : null}
                    <TableCell className="font-mono tabular-nums">{item.seed}</TableCell>
                    <TableCell>
                      <Badge
                        variant={item.status === 'failed' ? 'destructive' : 'secondary'}
                      >
                        {item.status === 'creating' || item.status === 'binding' ? (
                          <Loader2 className="animate-spin" />
                        ) : null}
                        {item.status === 'complete'
                          ? '已完成'
                          : item.status === 'creating'
                            ? '正在创建'
                            : item.status === 'binding'
                              ? '正在关联'
                              : item.status === 'failed'
                                ? item.profile
                                  ? '待关联'
                                  : '待重试'
                                : '待处理'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {conflicts.length ? (
              <Field orientation="horizontal">
                <Checkbox
                  id="batch-confirm-conflicts"
                  checked={confirmConflicts}
                  disabled={busy}
                  onCheckedChange={(checked) => setConfirmConflicts(checked === true)}
                />
                <FieldLabel htmlFor="batch-confirm-conflicts">
                  确认为 {conflicts.length} 个已有其他窗口关联的账号新增关联
                </FieldLabel>
              </Field>
            ) : null}
            {refreshError ? <FieldError role="alert">{refreshError}</FieldError> : null}
          </div>
          <DialogFooter>
            {busy ? (
              <Button
                variant="outline"
                disabled={stopping}
                onClick={() => {
                  job.current?.stopAfterCurrent()
                  setStopping(true)
                }}
              >
                {stopping ? '正在停止…' : '完成当前项后停止'}
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={onClose}>
                  关闭
                </Button>
                {completed < items.length ? (
                  <Button
                    onClick={() => {
                      if (confirmConflicts) {
                        for (const item of conflicts) {
                          if (item.account) confirmedAccounts.current.add(item.account.id)
                        }
                      }
                      setConfirmConflicts(false)
                      if (job.current) void run(job.current)
                    }}
                  >
                    {failed ? '重试未完成项' : '继续创建'}
                  </Button>
                ) : null}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      ) : context ? (
        <WindowEditor
          window={null}
          groups={context.groups}
          takenNames={context.profiles.map((profile) => profile.name)}
          licenseStatus={context.license}
          batch={{
            count,
            ...(accounts ? {} : { onCountChange: setCount }),
            fromAccounts: !!accounts,
            fields: accounts ? (
              <FieldGroup>
                <div
                  className="flex max-h-24 flex-wrap gap-1 overflow-y-auto"
                  aria-label="所选账号"
                >
                  {accounts.map((account) => (
                    <Badge key={account.id} variant="secondary" className="max-w-full">
                      <span className="truncate">{account.label}</span>
                      {context.boundAccountIds.has(account.id) ? ' · 已有关联' : ''}
                    </Badge>
                  ))}
                </div>
                {alreadyBound.length ? (
                  <Alert>
                    <AlertDescription>
                      <Field orientation="horizontal">
                        <Checkbox
                          id="batch-allow-existing"
                          checked={allowExisting}
                          onCheckedChange={(checked) =>
                            setAllowExisting(checked === true)
                          }
                        />
                        <FieldLabel htmlFor="batch-allow-existing">
                          {alreadyBound.length} 个账号已关联窗口，仍为它们创建并关联新窗口
                        </FieldLabel>
                      </Field>
                    </AlertDescription>
                  </Alert>
                ) : null}
              </FieldGroup>
            ) : undefined,
          }}
          onSave={start}
          onCancel={onClose}
        />
      ) : (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>批量创建窗口</DialogTitle>
            <DialogDescription>
              {loadError ? '暂时无法读取创建配置。' : '正在读取窗口、分组和账号配置…'}
            </DialogDescription>
          </DialogHeader>
          {loadError ? (
            <FieldError role="alert">{loadError}</FieldError>
          ) : (
            <Loader2 className="animate-spin" />
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            {loadError ? (
              <Button
                onClick={() => {
                  setLoadError(null)
                  setLoadAttempt((current) => current + 1)
                }}
              >
                重试
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
