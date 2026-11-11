import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { openExternalUrl, safeExternalHttpUrl } from '@/lib/platform/external-url'
import type { PluginView } from '@/lib/platform/native-plugins'
import {
  getOrderWatchSettings,
  listOrderWatches,
  runOrderWatch,
  saveOrderWatchSettings,
  setOrderWatchEnabled,
  testOrderWatchBark,
} from './api'
import type {
  OrderCandidate,
  OrderWatchSettings,
  OrderWatchView,
} from './order-watch-types'
import { message } from './types'

interface OrderWatchPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  plugin: PluginView | null
  accounts: readonly { id: string; account: string }[]
}

type Draft = Omit<OrderWatchSettings, 'intervalMinutes'> & { intervalMinutes: string }

interface PanelState {
  identity: string | null
  saved: OrderWatchSettings | null
  draft: Draft | null
  settingsError: string | null
  settingsNotice: string | null
  settingsAction: 'save' | 'test' | null
  intervalInvalid: boolean
  baseUrlInvalid: boolean
  keyInvalid: boolean
  items: OrderWatchView[] | null
  listError: string | null
  selectedId: string | null
  detail: OrderWatchView | null
  detailError: string | null
  busyAccounts: string[]
  actionError: string | null
  actionNotice: string | null
}

interface Session {
  identity: string
  active: boolean
  settingsReading: boolean
  settingsAction: boolean
  accountActions: Set<string>
  revision: number
  readSettings: () => Promise<void>
}

function emptyState(identity: string | null): PanelState {
  return {
    identity,
    saved: null,
    draft: null,
    settingsError: null,
    settingsNotice: null,
    settingsAction: null,
    intervalInvalid: false,
    baseUrlInvalid: false,
    keyInvalid: false,
    items: null,
    listError: null,
    selectedId: null,
    detail: null,
    detailError: null,
    busyAccounts: [],
    actionError: null,
    actionNotice: null,
  }
}

function draftOf(settings: OrderWatchSettings): Draft {
  return { intervalMinutes: String(settings.intervalMinutes), bark: { ...settings.bark } }
}

function changed(draft: Draft | null, saved: OrderWatchSettings | null): boolean {
  return (
    draft !== null &&
    saved !== null &&
    (draft.intervalMinutes !== String(saved.intervalMinutes) ||
      draft.bark.baseUrl !== saved.bark.baseUrl ||
      draft.bark.deviceKey !== saved.bark.deviceKey ||
      draft.bark.enabled !== saved.bark.enabled)
  )
}

function dateText(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

const candidateLabels: Record<OrderCandidate['status'], string> = {
  pending: '待核查',
  sold: '页面确认已售',
  reappeared: '重新出现',
}

export function OrderWatchPanel({
  open,
  onOpenChange,
  plugin,
  accounts,
}: OrderWatchPanelProps) {
  const identity = plugin
    ? JSON.stringify([
        plugin.id,
        plugin.version,
        plugin.source,
        plugin.status?.pid ?? null,
      ])
    : null
  const active =
    open &&
    plugin?.state === 'running' &&
    plugin.methods.includes('vinted.accounts.orders.list')
  const [state, setState] = useState(() => emptyState(identity))
  const sessionRef = useRef<Session | null>(null)
  const current = state.identity === identity ? state : emptyState(identity)
  const selected = current.items?.find((item) => item.accountId === current.selectedId)
  const selectedId = selected?.accountId ?? null
  const labels = new Map(accounts.map((account) => [account.id, account.account]))

  const update = useCallback(
    (session: Session, apply: (value: PanelState) => PanelState) => {
      if (!session.active || sessionRef.current !== session) return
      setState((value) =>
        apply(value.identity === session.identity ? value : emptyState(session.identity)),
      )
    },
    [],
  )

  useEffect(() => {
    if (!active || identity === null) return
    const session: Session = {
      identity,
      active: true,
      settingsReading: false,
      settingsAction: false,
      accountActions: new Set(),
      revision: 0,
      readSettings,
    }
    sessionRef.current = session

    async function readSettings() {
      if (!session.active || session.settingsReading) return
      session.settingsReading = true
      try {
        const saved = await getOrderWatchSettings()
        update(session, (value) => ({
          ...value,
          saved,
          draft: changed(value.draft, value.saved) ? value.draft : draftOf(saved),
          settingsError: null,
          settingsNotice: null,
          settingsAction: null,
          busyAccounts: [...session.accountActions],
        }))
      } catch (cause) {
        update(session, (value) => ({
          ...value,
          settingsError: message(cause),
          settingsAction: null,
        }))
      } finally {
        session.settingsReading = false
      }
    }

    let reading = false
    async function readSummaries() {
      if (!session.active || reading) return
      reading = true
      const revision = session.revision
      try {
        const { items } = await listOrderWatches()
        if (revision !== session.revision) return
        update(session, (value) => {
          const nextId = items.some((item) => item.accountId === value.selectedId)
            ? value.selectedId
            : (items[0]?.accountId ?? null)
          return {
            ...value,
            items,
            listError: null,
            selectedId: nextId,
            detail: nextId === value.selectedId ? value.detail : null,
            detailError: nextId === value.selectedId ? value.detailError : null,
          }
        })
      } catch (cause) {
        update(session, (value) => ({ ...value, listError: message(cause) }))
      } finally {
        reading = false
      }
    }

    void readSettings()
    void readSummaries()
    const timer = setInterval(() => void readSummaries(), 5_000)
    return () => {
      session.active = false
      clearInterval(timer)
      if (sessionRef.current === session) sessionRef.current = null
    }
  }, [active, identity, update])

  useEffect(() => {
    const session = sessionRef.current
    if (!active || !session || session.identity !== identity || selectedId === null)
      return
    const pollingSession = session
    const accountId = selectedId
    let live = true
    let reading = false
    async function readDetail() {
      if (!live || !pollingSession.active || reading) return
      reading = true
      try {
        const { items } = await listOrderWatches({ accountId })
        if (!live) return
        const detail = items.find((item) => item.accountId === accountId)
        update(pollingSession, (value) =>
          value.selectedId === accountId
            ? {
                ...value,
                detail: detail ?? null,
                detailError: detail ? null : '该账号已不在查询列表中，请等待状态刷新。',
              }
            : value,
        )
      } catch (cause) {
        if (live)
          update(pollingSession, (value) => ({ ...value, detailError: message(cause) }))
      } finally {
        reading = false
      }
    }
    void readDetail()
    const timer = setInterval(() => void readDetail(), 5_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [active, identity, selectedId, update])

  function patchDraft(patch: Partial<Draft>) {
    if (!active || current.settingsAction !== null) return
    setState((value) =>
      value.draft
        ? {
            ...value,
            draft: { ...value.draft, ...patch },
            settingsError: null,
            settingsNotice: null,
            intervalInvalid: false,
            baseUrlInvalid: false,
            keyInvalid: false,
          }
        : value,
    )
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const session = sessionRef.current
    const draft = current.draft
    if (
      !active ||
      !session?.active ||
      session.settingsAction ||
      session.settingsReading ||
      !draft
    )
      return
    const intervalMinutes = Number(draft.intervalMinutes)
    const intervalInvalid =
      draft.intervalMinutes.trim() === '' ||
      !Number.isInteger(intervalMinutes) ||
      intervalMinutes < 5 ||
      intervalMinutes > 1440
    const baseUrlInvalid = !safeExternalHttpUrl(draft.bark.baseUrl)
    const keyInvalid = draft.bark.enabled && draft.bark.deviceKey.trim() === ''
    if (intervalInvalid || baseUrlInvalid || keyInvalid) {
      update(session, (value) => ({
        ...value,
        intervalInvalid,
        baseUrlInvalid,
        keyInvalid,
        settingsNotice: null,
        settingsError: intervalInvalid
          ? '扫描间隔须为 5–1440 分钟的整数。'
          : baseUrlInvalid
            ? '请填写有效的 Bark HTTP(S) 服务地址。'
            : '启用 Bark 前请填写设备密钥。',
      }))
      return
    }
    session.settingsAction = true
    update(session, (value) => ({
      ...value,
      settingsAction: 'save',
      settingsError: null,
      settingsNotice: null,
    }))
    try {
      const saved = await saveOrderWatchSettings({
        intervalMinutes,
        bark: { ...draft.bark },
      })
      update(session, (value) => ({
        ...value,
        saved,
        draft: draftOf(saved),
        settingsNotice: '设置已保存',
      }))
    } catch (cause) {
      update(session, (value) => ({ ...value, settingsError: message(cause) }))
    } finally {
      session.settingsAction = false
      update(session, (value) => ({ ...value, settingsAction: null }))
    }
  }

  async function testBark() {
    const session = sessionRef.current
    if (
      !active ||
      !session?.active ||
      session.settingsAction ||
      session.settingsReading ||
      !current.saved?.bark.deviceKey.trim()
    )
      return
    session.settingsAction = true
    update(session, (value) => ({
      ...value,
      settingsAction: 'test',
      settingsError: null,
      settingsNotice: null,
    }))
    try {
      await testOrderWatchBark()
      update(session, (value) => ({ ...value, settingsNotice: '测试通知已发送' }))
    } catch (cause) {
      update(session, (value) => ({ ...value, settingsError: message(cause) }))
    } finally {
      session.settingsAction = false
      update(session, (value) => ({ ...value, settingsAction: null }))
    }
  }

  async function accountAction(item: OrderWatchView, action: 'run' | 'enabled') {
    const session = sessionRef.current
    if (
      !active ||
      !session?.active ||
      session.accountActions.has(item.accountId) ||
      (action === 'run' && (!item.enabled || item.running))
    )
      return
    session.accountActions.add(item.accountId)
    update(session, (value) => ({
      ...value,
      busyAccounts: [...session.accountActions],
      actionError: null,
      actionNotice: null,
    }))
    const label = labels.get(item.accountId) ?? item.accountId
    try {
      if (action === 'run') {
        const { queued } = await runOrderWatch(item.accountId)
        update(session, (value) => ({
          ...value,
          actionNotice: `${label}：${queued ? '已加入查询队列' : '当前查询繁忙，请稍后重试'}`,
        }))
      } else {
        const { enabled } = await setOrderWatchEnabled(item.accountId, !item.enabled)
        session.revision += 1
        update(session, (value) => ({
          ...value,
          items:
            value.items?.map((row) =>
              row.accountId === item.accountId
                ? { ...row, enabled, nextRunAt: enabled ? row.nextRunAt : null }
                : row,
            ) ?? null,
          actionNotice: `${label}：${enabled ? '已启用自动查询' : '已暂停自动查询'}`,
        }))
      }
    } catch (cause) {
      update(session, (value) => ({
        ...value,
        actionError: `${label}：${message(cause)}`,
      }))
    } finally {
      session.accountActions.delete(item.accountId)
      update(session, (value) => ({
        ...value,
        busyAccounts: [...session.accountActions],
      }))
    }
  }

  async function openLink(url: string) {
    const session = sessionRef.current
    if (!active || !session?.active) return
    try {
      await openExternalUrl(url)
    } catch (cause) {
      update(session, (value) => ({ ...value, actionError: message(cause) }))
    }
  }

  if (!open) return null
  const draft = current.draft
  const settingsDisabled = !active || current.settingsAction !== null
  const detail = current.detail?.accountId === selectedId ? current.detail : null
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && sessionRef.current) sessionRef.current.active = false
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>订单查询</DialogTitle>
          <DialogDescription>
            首次完整扫描只建立基线；商品消失后需由商品页确认已售。这里只核查公开页面，
            不是已登录账号的真实订单。
          </DialogDescription>
        </DialogHeader>

        {!active ? (
          <FieldError>账号插件尚未运行或不支持订单查询。</FieldError>
        ) : (
          <>
            {draft ? (
              <form onSubmit={(event) => void save(event)} noValidate>
                <FieldGroup className="gap-3">
                  <FieldGroup className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)]">
                    <Field data-invalid={current.intervalInvalid}>
                      <FieldLabel htmlFor="order-watch-interval">
                        扫描间隔（分钟）
                      </FieldLabel>
                      <Input
                        id="order-watch-interval"
                        aria-label="扫描间隔（分钟）"
                        type="number"
                        min={5}
                        max={1440}
                        step={1}
                        required
                        aria-invalid={current.intervalInvalid}
                        value={draft.intervalMinutes}
                        disabled={settingsDisabled}
                        onChange={(event) =>
                          patchDraft({ intervalMinutes: event.target.value })
                        }
                      />
                    </Field>
                    <Field data-invalid={current.baseUrlInvalid}>
                      <FieldLabel htmlFor="order-watch-bark-url">
                        Bark 服务地址
                      </FieldLabel>
                      <Input
                        id="order-watch-bark-url"
                        aria-label="Bark 服务地址"
                        type="url"
                        aria-invalid={current.baseUrlInvalid}
                        value={draft.bark.baseUrl}
                        disabled={settingsDisabled}
                        onChange={(event) =>
                          patchDraft({
                            bark: { ...draft.bark, baseUrl: event.target.value },
                          })
                        }
                      />
                    </Field>
                    <Field data-invalid={current.keyInvalid}>
                      <FieldLabel htmlFor="order-watch-bark-key">
                        Bark 设备密钥
                      </FieldLabel>
                      <Input
                        id="order-watch-bark-key"
                        aria-label="Bark 设备密钥"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={current.keyInvalid}
                        value={draft.bark.deviceKey}
                        disabled={settingsDisabled}
                        onChange={(event) =>
                          patchDraft({
                            bark: { ...draft.bark, deviceKey: event.target.value },
                          })
                        }
                      />
                    </Field>
                  </FieldGroup>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Field orientation="horizontal" className="w-auto">
                      <Switch
                        id="order-watch-bark-enabled"
                        aria-label="启用 Bark 通知"
                        checked={draft.bark.enabled}
                        disabled={settingsDisabled}
                        onCheckedChange={(enabled) =>
                          patchDraft({ bark: { ...draft.bark, enabled } })
                        }
                      />
                      <FieldLabel htmlFor="order-watch-bark-enabled">
                        启用 Bark 通知
                      </FieldLabel>
                    </Field>
                    <div className="flex flex-wrap items-center gap-2">
                      {!current.saved?.bark.deviceKey.trim() ? (
                        <span className="text-xs text-muted-foreground">
                          测试前请先保存设备密钥
                        </span>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={
                          settingsDisabled || !current.saved?.bark.deviceKey.trim()
                        }
                        onClick={() => void testBark()}
                      >
                        {current.settingsAction === 'test' ? (
                          <Loader2 data-icon="inline-start" className="animate-spin" />
                        ) : null}
                        测试已保存配置
                      </Button>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={settingsDisabled || !changed(draft, current.saved)}
                      >
                        {current.settingsAction === 'save' ? (
                          <Loader2 data-icon="inline-start" className="animate-spin" />
                        ) : null}
                        保存设置
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    密钥随配置明文保存在插件本地数据中。
                  </p>
                </FieldGroup>
              </form>
            ) : current.settingsError === null ? (
              <p role="status" className="text-sm text-muted-foreground">
                正在读取设置…
              </p>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const session = sessionRef.current
                  if (!session?.active || session.settingsReading) return
                  update(session, (value) => ({ ...value, settingsError: null }))
                  void session.readSettings()
                }}
              >
                重试读取设置
              </Button>
            )}
            {current.settingsError ? (
              <FieldError>{current.settingsError}</FieldError>
            ) : null}
            {current.settingsNotice ? (
              <p role="status" className="text-sm text-muted-foreground">
                {current.settingsNotice}
              </p>
            ) : null}

            <Separator />
            {current.listError ? <FieldError>{current.listError}</FieldError> : null}
            {current.actionError ? <FieldError>{current.actionError}</FieldError> : null}
            {current.actionNotice ? (
              <p role="status" className="text-sm text-muted-foreground">
                {current.actionNotice}
              </p>
            ) : null}
            <div className="max-h-64 overflow-y-auto">
              <Table aria-label="账号自动查询状态">
                <TableHeader>
                  <TableRow>
                    <TableHead>账号</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>最近完整扫描</TableHead>
                    <TableHead>商品 / 核查</TableHead>
                    <TableHead>下次查询</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {current.items?.map((item) => {
                    const label = labels.get(item.accountId) ?? item.accountId
                    const busy = current.busyAccounts.includes(item.accountId)
                    const rowDetail = detail?.accountId === item.accountId ? detail : item
                    return (
                      <TableRow
                        key={item.accountId}
                        data-state={
                          selectedId === item.accountId ? 'selected' : undefined
                        }
                      >
                        <TableCell className="max-w-56">
                          <Button
                            type="button"
                            variant="link"
                            size="sm"
                            className="max-w-full justify-start px-0"
                            aria-label={`查看 ${label} 的核查记录`}
                            aria-pressed={selectedId === item.accountId}
                            onClick={() =>
                              setState((value) => ({
                                ...value,
                                selectedId: item.accountId,
                                detail:
                                  value.selectedId === item.accountId
                                    ? value.detail
                                    : null,
                                detailError: null,
                              }))
                            }
                          >
                            <span className="truncate">{label}</span>
                          </Button>
                          <p className="truncate text-xs text-muted-foreground">
                            {rowDetail.homepageUrl}
                          </p>
                          {rowDetail.lastError ? (
                            <p className="text-xs text-destructive">
                              {rowDetail.lastError}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Badge variant={item.running ? 'secondary' : 'outline'}>
                            {item.running
                              ? '查询中'
                              : item.enabled
                                ? '自动查询已启用'
                                : '已暂停'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {item.lastCompleteAt
                            ? dateText(item.lastCompleteAt)
                            : '尚未完整扫描'}
                        </TableCell>
                        <TableCell>
                          <span>{item.lastItemCount ?? '—'} 件</span>
                          <p className="text-xs text-muted-foreground">
                            待核查 {item.pendingCount ?? '—'} · 页面确认已售{' '}
                            {item.soldCount ?? '—'}
                          </p>
                        </TableCell>
                        <TableCell>{dateText(item.nextRunAt)}</TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-label={`立即查询 ${label}`}
                              disabled={busy || item.running || !item.enabled}
                              onClick={() => void accountAction(item, 'run')}
                            >
                              <RefreshCw data-icon="inline-start" />
                              立即查询
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`${item.enabled ? '暂停' : '启用'} ${label}`}
                              disabled={busy}
                              onClick={() => void accountAction(item, 'enabled')}
                            >
                              {item.enabled ? '暂停' : '启用'}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`打开 ${label} 的主页`}
                              disabled={!safeExternalHttpUrl(rowDetail.homepageUrl)}
                              onClick={() => void openLink(rowDetail.homepageUrl)}
                            >
                              <ExternalLink />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            {current.items === null && !current.listError ? (
              <p role="status" className="text-sm text-muted-foreground">
                正在读取查询状态…
              </p>
            ) : current.items?.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>暂无可查询账号</EmptyTitle>
                  <EmptyDescription>
                    在账号资料中填写 Vinted 用户主页后可自动查询。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}

            {selected ? (
              <>
                <Separator />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">
                    {labels.get(selected.accountId) ?? selected.accountId} · 商品核查
                  </h3>
                  <span className="text-xs text-muted-foreground">最近 100 条</span>
                </div>
                {current.detailError ? (
                  <Alert variant="destructive">
                    <AlertDescription>{current.detailError}</AlertDescription>
                  </Alert>
                ) : null}
                {detail ? (
                  detail.candidates.length ? (
                    <Table aria-label="商品页面核查记录">
                      <TableHeader>
                        <TableRow>
                          <TableHead>商品</TableHead>
                          <TableHead>页面核查</TableHead>
                          <TableHead>最近出现 / 消失</TableHead>
                          <TableHead>Bark</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.candidates.map((item) => (
                          <TableRow key={item.id}>
                            <TableCell className="max-w-64">
                              <Button
                                type="button"
                                variant="link"
                                size="sm"
                                className="max-w-full justify-start px-0"
                                aria-label={`打开商品 ${item.title}`}
                                disabled={!safeExternalHttpUrl(item.itemUrl)}
                                onClick={() => void openLink(item.itemUrl)}
                              >
                                <span className="truncate">
                                  {item.title || item.itemId}
                                </span>
                                <ExternalLink data-icon="inline-end" />
                              </Button>
                              <p className="text-xs text-muted-foreground">
                                {item.itemId}
                              </p>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={item.status === 'sold' ? 'secondary' : 'outline'}
                              >
                                {candidateLabels[item.status]}
                              </Badge>
                              <p className="text-xs text-muted-foreground">
                                核查 {dateText(item.checkedAt)}
                              </p>
                              {item.checkError ? (
                                <p className="text-xs text-destructive">
                                  {item.checkError}
                                </p>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-xs">
                              <p>{dateText(item.lastSeenAt)}</p>
                              <p>{dateText(item.missingAt)}</p>
                            </TableCell>
                            <TableCell className="text-xs">
                              {item.notifiedAt ? (
                                <span>已发送 {dateText(item.notifiedAt)}</span>
                              ) : item.notifyError ? (
                                <span className="text-destructive">
                                  {item.notifyError}
                                </span>
                              ) : item.status === 'sold' ? (
                                '未发送'
                              ) : (
                                '—'
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>暂无商品核查记录</EmptyTitle>
                      </EmptyHeader>
                    </Empty>
                  )
                ) : !current.detailError ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    正在读取核查记录…
                  </p>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
