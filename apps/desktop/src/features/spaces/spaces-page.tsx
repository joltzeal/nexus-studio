import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ArrowUpRight,
  Check,
  Dices,
  Ellipsis,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Trash2,
  Unlink,
  UserRound,
} from 'lucide-react'
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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toast'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  listProxyProviders,
  listPlugins,
  type PluginView,
} from '@/lib/platform/native-plugins'
import {
  bindAccount,
  listAccounts,
  listBindings,
  saveAccount,
  unbindWindow,
} from '@/features/accounts/api'
import {
  ACCOUNTS_PLUGIN_ID,
  EMPTY_ACCOUNT,
  LOGIN_METHOD_LABELS,
  STATUS_LABELS,
  type Account,
  type BindingView,
} from '@/features/accounts/types'
import { listGroups, type WindowGroup } from '@/lib/platform/native-groups'
import {
  createNativeProfile,
  deleteNativeProfile,
  listNativeProfiles,
  nativeProfilesAvailable,
  updateNativeProfile,
  type NativeProfile,
  type WindowSettings,
} from '@/lib/platform/native-profiles'
import { getLicenseStatus, type LicenseStatus } from '@/lib/platform/native-license'
import {
  getKernelStatus,
  type InstalledKernel,
  type KernelSelection,
} from '@/lib/platform/native-kernels'
import { WindowKernelPicker } from './window-kernel-picker'
import { parseWindowConfig, type WindowConfig } from '@/demo/model'
import { configOf } from '@/features/spaces/window-config'
import { formatAbsolute, formatRelative, majorVersion } from '@/lib/format-time'
import { randomFingerprintSeed, randomWindowName } from '@/lib/random-name'
import {
  EMPTY_QUERY,
  flagOf,
  type CheckResult,
  type ProxyRow,
} from '@/features/proxy/types'
import { getConfig, listProxies } from '@/features/proxy/api'
import { ProxyCheckSummary } from '@/features/proxy/proxy-check-summary'
import { checkWindowProxy, hasProxy } from './window-proxy'
import { ProxyGateDialog } from './proxy-gate'
import { TransferToolbar } from './transfer-toolbar'
import { TransferRecoveryNotice } from './transfer-recovery'
import { useTransferRecovery } from './use-transfer-recovery'
import { toggleSelection, withDeadline } from './transfer-state'
import { useWindowLaunch } from './use-window-launch'

function message(error: unknown): string {
  return typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '操作失败，请重试。'
}

export function SpacesPage() {
  const native = nativeProfilesAvailable()
  const [windows, setWindows] = useState<NativeProfile[]>([])
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null)
  const [groups, setGroups] = useState<WindowGroup[]>([])
  const [groupFilter, setGroupFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [accountPlugin, setAccountPlugin] = useState<PluginView | null>(null)
  const [bindings, setBindings] = useState<BindingView[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [binding, setBinding] = useState<NativeProfile | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [conflict, setConflict] = useState<{
    window: NativeProfile
    accountId: string
    duplicates: string[]
  } | null>(null)
  const [bindingError, setBindingError] = useState<string | null>(null)
  const [bindingPending, setBindingPending] = useState(false)
  const recovery = useTransferRecovery(native)

  const {
    gate,
    operatingWindows,
    unconfirmedWindows,
    open,
    stop,
    refreshGate,
    closeGate,
  } = useWindowLaunch(setWindows, setError)

  const load = useCallback(async () => {
    const records = await withDeadline(
      listNativeProfiles(),
      10_000,
      '读取窗口列表超时，请重试刷新。',
    )
    setWindows(records)
  }, [])

  async function refresh() {
    if (refreshing) return
    recovery.retry()
    setRefreshing(true)
    try {
      const [records, currentGroups] = await withDeadline(
        Promise.all([listNativeProfiles(), listGroups()]),
        10_000,
        '刷新窗口和分组超时，请重试。',
      )
      setWindows(records)
      setGroups(currentGroups)
      setError(null)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!native) return
    let active = true
    void listGroups().then(
      (items) => {
        if (active) setGroups(items)
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [native])

  useEffect(() => {
    if (!native) return
    let active = true
    void listNativeProfiles().then(
      (records) => {
        if (active) setWindows(records)
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [native])

  useEffect(() => {
    if (!native) return
    let active = true
    void getLicenseStatus().then(
      (status) => {
        if (active) setLicenseStatus(status)
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [native])

  // Relative times ("3 分钟前") go stale while the page sits open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const accountsInstalled = accountPlugin !== null && accountPlugin.state !== 'available'
  const accountsRunning = accountsInstalled && accountPlugin.state === 'running'

  useEffect(() => {
    if (!native) return
    let active = true
    void listPlugins().then(
      (catalog) => {
        if (active) {
          setAccountPlugin(
            catalog.find((entry) => entry.id === ACCOUNTS_PLUGIN_ID) ?? null,
          )
        }
      },
      () => {
        // Without a catalog the account column simply stays hidden.
      },
    )
    return () => {
      active = false
    }
  }, [native])

  // The host has no push channel: look again while the plugin is coming up.
  useEffect(() => {
    if (!native || accountsRunning) return
    const timer = setInterval(() => {
      void listPlugins().then(
        (catalog) => {
          setAccountPlugin(
            catalog.find((entry) => entry.id === ACCOUNTS_PLUGIN_ID) ?? null,
          )
        },
        () => undefined,
      )
    }, 3000)
    return () => clearInterval(timer)
  }, [native, accountsRunning])

  const refreshBindings = useCallback(async () => {
    if (!accountsRunning) return
    const [bound, catalog] = await Promise.all([listBindings(), listAccounts()])
    setBindings(bound.items)
    setAccounts(catalog.items)
  }, [accountsRunning])

  async function refreshAfterImport() {
    const [records, currentGroups] = await withDeadline(
      Promise.all([listNativeProfiles(), listGroups()]),
      10_000,
      '刷新窗口和分组超时',
    )
    setWindows(records)
    setGroups(currentGroups)
    setSelectedIds(new Set())
    await withDeadline(refreshBindings(), 10_000, '刷新账号关联超时')
  }

  useEffect(() => {
    // While the plugin is down its data is not shown at all (see `bound`), so
    // there is nothing to clear here: a stale list would only flash back.
    if (!accountsRunning) return
    let active = true
    void Promise.all([listBindings(), listAccounts()]).then(
      ([bound, catalog]) => {
        if (!active) return
        setBindings(bound.items)
        setAccounts(catalog.items)
      },
      () => {
        if (active) setBindings([])
      },
    )
    return () => {
      active = false
    }
  }, [accountsRunning])

  async function bind(window: NativeProfile, accountId: string | null) {
    setBindingPending(true)
    setBindingError(null)
    try {
      if (accountId === null) {
        await unbindWindow(window.id)
        toast.success('已解除关联')
      } else {
        const result = await bindAccount(accountId, window.id)
        if (!result.bound) {
          // Nothing was written: the warning comes first.
          setConflict({ window, accountId, duplicates: result.duplicates })
          return
        }
        toast.success('已关联账号')
      }
      await refreshBindings()
      setBinding(null)
    } catch (cause) {
      setBindingError(message(cause))
    } finally {
      setBindingPending(false)
    }
  }

  async function confirmDuplicate() {
    if (conflict === null) return
    setBindingPending(true)
    setBindingError(null)
    try {
      await bindAccount(conflict.accountId, conflict.window.id, true)
      await refreshBindings()
      toast.success('已关联账号')
      setConflict(null)
      setBinding(null)
    } catch (cause) {
      setBindingError(message(cause))
      setConflict(null)
    } finally {
      setBindingPending(false)
    }
  }

  function bindingOf(windowId: string): BindingView | null {
    // Bindings come from the plugin: without a running process they are stale.
    if (!accountsRunning) return null
    return bindings.find((entry) => entry.windowId === windowId) ?? null
  }

  /** The plugin stores opaque window ids; only this page knows their names. */
  function windowName(id: string): string {
    return windows.find((entry) => entry.id === id)?.name ?? id
  }

  function accountLabel(id: string): string {
    return accounts.find((entry) => entry.id === id)?.account ?? id
  }

  const visible = windows.filter(
    (window) =>
      (groupFilter === 'all' ||
        (groupFilter === 'ungrouped'
          ? !window.groupId
          : window.groupId === groupFilter)) &&
      `${window.name} ${window.settings.platform} ${window.settings.note} ${window.version} ${window.proxy ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  )
  const selected = windows.find((window) => window.id === viewing)
  const transferWindows = windows.filter((window) => selectedIds.has(window.id))
  const selectableIds = visible
    .filter((window) => !window.running && !operatingWindows.has(window.id))
    .map((window) => window.id)
  const selectedVisibleCount = selectableIds.filter((id) => selectedIds.has(id)).length
  const target = windows.find((window) => window.id === deleting)
  const running = windows.filter((window) => window.running).length
  const proxied = windows.filter((window) => hasProxy(window)).length
  const bound = accountsInstalled
    ? windows.filter((window) => bindingOf(window.id) !== null).length
    : 0

  return (
    <section className="collection-page page-reveal" aria-labelledby="spaces-heading">
      <div className="section-intro">
        <div>
          <h1 className="page-heading" id="spaces-heading">
            窗口管理
          </h1>
          <p className="page-description">管理窗口配置与运行状态。</p>
        </div>
        <div className="section-actions">
          <Button
            variant="outline"
            disabled={!native || refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw
              data-icon="inline-start"
              className={refreshing ? 'animate-spin' : undefined}
            />
            {refreshing ? '刷新中…' : '刷新'}
          </Button>
          <Button
            disabled={!native}
            onClick={() => {
              setError(null)
              setEditing('new')
            }}
          >
            <Plus data-icon="inline-start" />
            创建窗口
          </Button>
        </div>
      </div>
      {!native ? (
        <p className="native-profiles-hint" role="status">
          请在 Nexus 桌面应用中创建和打开窗口；网页预览无法访问本机浏览器。
        </p>
      ) : null}
      {error ? <FieldError role="alert">{error}</FieldError> : null}
      <TransferRecoveryNotice
        status={recovery.status}
        error={recovery.error}
        checking={recovery.checking}
        onRetry={recovery.retry}
      />

      {native ? (
        <div className="space-stats" aria-label="窗口概览">
          <div className="space-stat">
            <span>窗口</span>
            <strong>{windows.length}</strong>
          </div>
          <div className="space-stat" data-tone="success">
            <span>运行中</span>
            <strong>{running}</strong>
          </div>
          <div className="space-stat" data-tone="info">
            <span>已配代理</span>
            <strong>{proxied}</strong>
          </div>
          {accountsInstalled ? (
            <div className="space-stat" data-tone="warning">
              <span>已关联账号</span>
              <strong>{bound}</strong>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="collection-toolbar flex-wrap">
        <span className="result-count">{visible.length} 个窗口</span>
        <div className="search-field">
          <Search aria-hidden="true" />
          <Input
            aria-label="搜索窗口"
            placeholder="搜索名称、平台或备注"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {native ? (
          <Select value={groupFilter} onValueChange={setGroupFilter}>
            <SelectTrigger aria-label="筛选分组" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部分组</SelectItem>
              <SelectItem value="ungrouped">未分组</SelectItem>
              {groups.map((group) => (
                <SelectItem key={group.id} value={group.id}>
                  {group.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <TransferToolbar
          native={native}
          windows={transferWindows}
          operating={operatingWindows}
          onImported={refreshAfterImport}
          onClear={() => setSelectedIds(new Set())}
        />
      </div>

      <div className="space-table-panel">
        <div className="panel-heading">
          <h2>全部窗口</h2>
          <Badge variant="secondary">{windows.length}</Badge>
        </div>
        <Table aria-label="窗口列表">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label="全选当前筛选下的已关闭窗口"
                  disabled={!native || selectableIds.length === 0}
                  checked={
                    selectedVisibleCount === 0
                      ? false
                      : selectedVisibleCount === selectableIds.length
                        ? true
                        : 'indeterminate'
                  }
                  onCheckedChange={(checked) =>
                    setSelectedIds((current) =>
                      toggleSelection(current, selectableIds, checked === true),
                    )
                  }
                />
              </TableHead>
              <TableHead>窗口名称</TableHead>
              <TableHead>平台</TableHead>
              {accountsInstalled ? <TableHead>Vinted 账号</TableHead> : null}
              <TableHead>分组</TableHead>
              <TableHead>内核</TableHead>
              <TableHead>代理</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead>上次打开</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((window) => {
              const account = bindingOf(window.id)
              const busy = operatingWindows.has(window.id)
              const unconfirmed = unconfirmedWindows.has(window.id)
              return (
                <TableRow
                  key={window.id}
                  data-running={window.running ? 'true' : undefined}
                  data-state={selectedIds.has(window.id) ? 'selected' : undefined}
                >
                  <TableCell>
                    <Checkbox
                      aria-label={`选择窗口 ${window.name}`}
                      checked={selectedIds.has(window.id)}
                      disabled={window.running || busy}
                      onCheckedChange={(checked) =>
                        setSelectedIds((current) =>
                          toggleSelection(current, [window.id], checked === true),
                        )
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="space-name-cell">
                      <span
                        className="space-avatar"
                        data-tone={window.running ? 'blue' : undefined}
                        aria-hidden="true"
                      >
                        {window.name.slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <strong>{window.name}</strong>
                        <small>{window.settings.note || '无备注'}</small>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{window.settings.platform}</Badge>
                  </TableCell>
                  {accountsInstalled ? (
                    <TableCell>
                      {account === null ? (
                        <AccountQuickAdd
                          window={window}
                          ready={accountsRunning}
                          accounts={accounts}
                          onSaved={refreshBindings}
                        />
                      ) : (
                        <span className="account-cell">
                          <strong>{account.account?.account ?? '账号已删除'}</strong>
                          <small>
                            {account.account ? STATUS_LABELS[account.account.status] : ''}
                          </small>
                        </span>
                      )}
                    </TableCell>
                  ) : null}
                  <TableCell>
                    <span className="table-group">
                      {groups.find((group) => group.id === window.groupId)?.name ??
                        '未分组'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="kernel-version" title={window.version}>
                      {majorVersion(window.version)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <ProxyCell window={window} />
                  </TableCell>
                  <TableCell>
                    <TimeCell at={window.createdAt} now={now} fallback="—" />
                  </TableCell>
                  <TableCell>
                    <TimeCell at={window.lastOpenedAt} now={now} fallback="从未打开" />
                  </TableCell>
                  <TableCell>
                    <span
                      className="status-badge"
                      data-state={
                        unconfirmed ? 'pending' : window.running ? 'running' : 'stopped'
                      }
                    >
                      <span className="status-dot" aria-hidden="true" />
                      {unconfirmed
                        ? '状态待确认'
                        : busy
                          ? '操作中'
                          : window.running
                            ? '运行中'
                            : '已停止'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="table-actions">
                      <Button
                        variant={window.running ? 'outline' : 'default'}
                        size="sm"
                        disabled={busy && !unconfirmed}
                        onClick={() =>
                          void (unconfirmed
                            ? refreshGate(window)
                            : window.running
                              ? stop(window)
                              : open(window))
                        }
                      >
                        {unconfirmed ? (
                          <RefreshCw data-icon="inline-start" />
                        ) : busy ? (
                          <Loader2 data-icon="inline-start" className="animate-spin" />
                        ) : window.running ? (
                          <Square data-icon="inline-start" />
                        ) : (
                          <Play data-icon="inline-start" />
                        )}
                        {unconfirmed
                          ? '确认状态'
                          : busy
                            ? window.running
                              ? '正在停止…'
                              : '正在打开…'
                            : window.running
                              ? '停止'
                              : '打开'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`编辑 ${window.name}`}
                        disabled={window.running || busy}
                        onClick={() => setEditing(window.id)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`查看 ${window.name} 详情`}
                        onClick={() => setViewing(window.id)}
                      >
                        <ArrowUpRight />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`删除 ${window.name}`}
                        disabled={window.running || busy}
                        onClick={() => setDeleting(window.id)}
                      >
                        <Trash2 />
                      </Button>
                      {accountsInstalled ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`更多操作 ${window.name}`}
                            >
                              <Ellipsis />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Vinted 账号</DropdownMenuLabel>
                            <DropdownMenuItem
                              onSelect={() => {
                                setBindingError(null)
                                setBinding(window)
                              }}
                            >
                              <UserRound />
                              {account === null ? '关联账号' : '更换账号'}
                            </DropdownMenuItem>
                            {account === null ? null : (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  disabled={bindingPending}
                                  onSelect={() => void bind(window, null)}
                                >
                                  <Unlink />
                                  解除关联
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        {visible.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{windows.length ? '没有找到窗口' : '还没有窗口'}</EmptyTitle>
              <EmptyDescription>
                {windows.length
                  ? '调整搜索条件。'
                  : '创建窗口时会同时创建独立的浏览器环境。'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        {editing !== null ? (
          <WindowEditor
            key={editing}
            window={
              editing === 'new'
                ? null
                : (windows.find((item) => item.id === editing) ?? null)
            }
            groups={groups}
            takenNames={windows.map((item) => item.name)}
            onSave={async (
              name,
              proxy,
              proxyPlugin,
              proxyEndpoint,
              settings,
              kernel,
              groupId,
            ) => {
              if (editing === 'new') {
                const created = await createNativeProfile(
                  name,
                  proxy,
                  proxyPlugin,
                  proxyEndpoint,
                  settings,
                  kernel,
                  groupId,
                )
                setWindows((current) => [...current, created])
              } else {
                await updateNativeProfile(
                  editing,
                  name,
                  proxy,
                  proxyPlugin,
                  proxyEndpoint,
                  settings,
                  groupId,
                )
                await load()
              }
              setEditing(null)
            }}
            licenseStatus={licenseStatus}
            onCancel={() => setEditing(null)}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setViewing(null)
        }}
      >
        {selected ? (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{selected.name}</DialogTitle>
              <DialogDescription>
                独立浏览器环境 · 内核 {majorVersion(selected.version)}
              </DialogDescription>
            </DialogHeader>
            <dl className="about-details">
              <div className="about-row">
                <dt>平台</dt>
                <dd>{selected.settings.platform}</dd>
              </div>
              {accountsInstalled ? (
                <div className="about-row">
                  <dt>Vinted 账号</dt>
                  <dd>{bindingOf(selected.id)?.account?.account ?? '未关联'}</dd>
                </div>
              ) : null}
              <div className="about-row">
                <dt>分组</dt>
                <dd>
                  {groups.find((group) => group.id === selected.groupId)?.name ??
                    '未分组'}
                </dd>
              </div>
              <div className="about-row">
                <dt>备注</dt>
                <dd>{selected.settings.note || '无'}</dd>
              </div>
              <div className="about-row">
                <dt>代理</dt>
                <dd>
                  {selected.proxyPlugin
                    ? `代理池${selected.proxyEndpoint === null ? '（默认代理）' : ` · #${selected.proxyEndpoint}`}`
                    : (selected.proxy ?? '直连')}
                </dd>
              </div>
              <div className="about-row">
                <dt>出口 IP 自动匹配</dt>
                <dd>
                  {selected.settings.geoip
                    ? hasProxy(selected)
                      ? '启用'
                      : '已开启偏好（直连时不生效）'
                    : '关闭'}
                </dd>
              </div>
              <div className="about-row">
                <dt>时区 / 语言</dt>
                <dd>
                  {selected.settings.timezone || '默认'} /{' '}
                  {selected.settings.locale || '默认'}
                </dd>
              </div>
              <div className="about-row">
                <dt>窗口尺寸</dt>
                <dd>{selected.settings.viewport}</dd>
              </div>
              <div className="about-row">
                <dt>指纹种子</dt>
                <dd>{selected.settings.fingerprintSeed ?? '默认'}</dd>
              </div>
              <div className="about-row">
                <dt>起始地址</dt>
                <dd>{selected.settings.startUrl || '未设置'}</dd>
              </div>
              <div className="about-row">
                <dt>创建时间</dt>
                <dd>
                  {formatAbsolute(selected.createdAt)} ·{' '}
                  {formatRelative(selected.createdAt, now)}
                </dd>
              </div>
              <div className="about-row">
                <dt>上次打开</dt>
                <dd>
                  {selected.lastOpenedAt === null
                    ? '从未打开'
                    : `${formatAbsolute(selected.lastOpenedAt)} · ${formatRelative(
                        selected.lastOpenedAt,
                        now,
                      )}`}
                </dd>
              </div>
            </dl>
            <DialogFooter>
              <Button onClick={() => setViewing(null)}>关闭</Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>

      <AlertDialog
        open={!!target}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        {target ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除窗口「{target.name}」？</AlertDialogTitle>
              <AlertDialogDescription>
                将永久删除该窗口的浏览器数据，包括 Cookie 和登录状态，无法撤销。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={(event) => {
                  event.preventDefault()
                  void deleteNativeProfile(target.id)
                    .then(load)
                    .then(() => setDeleting(null))
                    .catch((cause: unknown) => setError(message(cause)))
                }}
              >
                删除窗口
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>

      <Dialog
        open={gate !== null}
        onOpenChange={(open) => {
          if (!open) closeGate()
        }}
      >
        {gate === null ? null : (
          <ProxyGateDialog
            name={gate.window.name}
            stage={gate.stage}
            onCancel={closeGate}
            onProceed={() => void open(gate.window)}
            onRefresh={() => void refreshGate(gate.window)}
          />
        )}
      </Dialog>

      <Dialog
        open={binding !== null}
        onOpenChange={(open) => {
          if (!open) setBinding(null)
        }}
      >
        {binding === null ? null : (
          <AccountBindDialog
            key={binding.id}
            window={binding}
            ready={accountsRunning}
            accounts={accountsRunning ? accounts : []}
            current={bindingOf(binding.id)?.accountId ?? null}
            pending={bindingPending}
            error={bindingError}
            onConfirm={(accountId) => void bind(binding, accountId)}
            onCancel={() => setBinding(null)}
          />
        )}
      </Dialog>

      <AlertDialog
        open={conflict !== null}
        onOpenChange={(open) => {
          if (!open) setConflict(null)
        }}
      >
        {conflict === null ? null : (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>同一个账号已经关联了其他窗口</AlertDialogTitle>
              <AlertDialogDescription>
                「{accountLabel(conflict.accountId)}」已关联到
                {conflict.duplicates.map((id) => `「${windowName(id)}」`).join('、')}。
                继续关联后会有 {conflict.duplicates.length + 1} 个窗口共用这个账号。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault()
                  void confirmDuplicate()
                }}
              >
                仍然关联
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </section>
  )
}

function ProxyCell({ window }: { window: NativeProfile }) {
  if (window.proxyPlugin !== null) {
    return (
      <span className="proxy-cell">
        <Badge variant="secondary">代理池</Badge>
        <small>
          {window.proxyEndpoint === null ? '默认代理' : `#${window.proxyEndpoint}`}
        </small>
      </span>
    )
  }
  if (window.proxy !== null) {
    return (
      <span className="proxy-cell">
        <span className="proxy-address" title={window.proxy}>
          {window.proxy}
        </span>
      </span>
    )
  }
  return <span className="table-muted">直连</span>
}

function TimeCell({
  at,
  now,
  fallback,
}: {
  at: number | null
  now: number
  fallback: string
}) {
  if (at === null || at <= 0) {
    return <span className="table-muted">{fallback}</span>
  }
  return (
    <span className="time-cell">
      <strong>{formatAbsolute(at, now)}</strong>
      <small>{formatRelative(at, now)}</small>
    </span>
  )
}

/**
 * Binding an account straight from the window row. The pool comes first —
 * most windows reuse a record that already exists — and the create form stays
 * below it for the first account of a new shop.
 */
function AccountQuickAdd({
  window,
  ready,
  accounts,
  onSaved,
}: {
  window: NativeProfile
  ready: boolean
  accounts: Account[]
  onSaved: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const visible = accounts
    .filter((item) =>
      `${item.account} ${item.note} ${item.phone}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .slice(0, 40)

  function reset() {
    setQuery('')
    setAccount('')
    setPassword('')
    setNote('')
    setError(null)
  }

  async function link(target: Account) {
    if (pending || !ready) return
    setPending(true)
    setError(null)
    try {
      const result = await bindAccount(target.id, window.id)
      await onSaved()
      if (result.bound) toast.success(`已关联 ${target.account}`)
      else toast.error('该账号已关联到其他窗口，请在更多操作里确认更换')
      reset()
      setOpen(false)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setPending(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending || !ready) return
    const login = account.trim()
    if (login === '' || password === '') {
      setError('账号和密码都要填写。')
      return
    }
    setPending(true)
    setError(null)
    try {
      const saved = await saveAccount({
        ...EMPTY_ACCOUNT,
        account: login,
        password,
        note: note.trim(),
      })
      const result = await bindAccount(saved.item.id, window.id)
      await onSaved()
      if (result.bound) {
        toast.success('账号已添加并关联')
      } else {
        toast.error('账号已保存，但它已关联到其他窗口，请在更多操作里确认更换')
      }
      reset()
      setOpen(false)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          disabled={!ready}
          title={ready ? '快捷关联或添加 Vinted 账号' : 'Vinted 账号插件还没就绪'}
        >
          <Plus data-icon="inline-start" />
          添加账号
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="account-quick-add">
        <PopoverHeader>
          <PopoverTitle>关联 Vinted 账号</PopoverTitle>
        </PopoverHeader>
        {accounts.length === 0 ? (
          <p className="account-quick-note">账号池还是空的，在下面新建一个。</p>
        ) : (
          <div className="account-quick-pool">
            <div className="search-field">
              <Search aria-hidden="true" />
              <Input
                aria-label="搜索账号池"
                placeholder="搜索账号池，点一行直接关联"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="account-picker" role="listbox" aria-label="账号池">
              {visible.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="account-option"
                  disabled={pending}
                  onClick={() => void link(item)}
                >
                  <span>
                    <strong>{item.account}</strong>
                    <small>
                      {LOGIN_METHOD_LABELS[item.loginMethod]} ·{' '}
                      {STATUS_LABELS[item.status]}
                      {item.phone === '' ? '' : ` · ${item.phone}`}
                    </small>
                  </span>
                  <UserRound aria-hidden="true" />
                </button>
              ))}
              {visible.length === 0 ? (
                <p className="account-quick-note">没有匹配的账号。</p>
              ) : null}
            </div>
          </div>
        )}
        <p className="account-quick-divider">
          {accounts.length === 0 ? '新建账号' : '或新建一个账号'}
        </p>
        <form className="account-quick-form" onSubmit={(event) => void submit(event)}>
          <Field>
            <FieldLabel htmlFor={`quick-account-${window.id}`}>账号</FieldLabel>
            <Input
              id={`quick-account-${window.id}`}
              autoComplete="off"
              placeholder="登录邮箱或用户名"
              value={account}
              onChange={(event) => setAccount(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`quick-password-${window.id}`}>密码</FieldLabel>
            <Input
              id={`quick-password-${window.id}`}
              type="password"
              autoComplete="off"
              placeholder="登录密码"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`quick-note-${window.id}`}>备注</FieldLabel>
            <Input
              id={`quick-note-${window.id}`}
              placeholder="可选"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          {error === null ? null : <FieldError role="alert">{error}</FieldError>}
          <div className="account-quick-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                reset()
                setOpen(false)
              }}
            >
              取消
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? '保存中…' : '保存并关联'}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}

function AccountBindDialog({
  window,
  ready,
  accounts,
  current,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  window: NativeProfile
  ready: boolean
  accounts: Account[]
  current: string | null
  pending: boolean
  error: string | null
  onConfirm: (accountId: string) => void
  onCancel: () => void
}) {
  const [selected, setSelected] = useState<string | null>(current)
  const [query, setQuery] = useState('')
  const visible = accounts.filter((account) =>
    `${account.account} ${account.note}`.toLowerCase().includes(query.toLowerCase()),
  )

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>关联 Vinted 账号</DialogTitle>
        <DialogDescription>{window.name} · 一个窗口只能关联一个账号。</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div className="search-field">
          <Search aria-hidden="true" />
          <Input
            aria-label="搜索可关联账号"
            placeholder="搜索账号或备注"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {!ready ? (
          <p className="text-sm text-muted-foreground">
            Vinted 账号插件还没就绪，稍后再试。
          </p>
        ) : accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            还没有账号。先到「插件中心 → Vinted 账号」新增或导入。
          </p>
        ) : (
          <div className="account-picker" role="listbox" aria-label="可关联账号">
            {visible.map((account) => (
              <button
                key={account.id}
                type="button"
                role="option"
                aria-selected={selected === account.id}
                className="account-option"
                data-selected={selected === account.id ? 'true' : undefined}
                disabled={pending}
                onClick={() => setSelected(account.id)}
              >
                <span>
                  <strong>{account.account}</strong>
                  <small>
                    {LOGIN_METHOD_LABELS[account.loginMethod]} ·{' '}
                    {STATUS_LABELS[account.status]}
                  </small>
                </span>
                {selected === account.id ? <Check aria-hidden="true" /> : null}
              </button>
            ))}
            {visible.length === 0 ? (
              <p className="text-sm text-muted-foreground">没有匹配的账号。</p>
            ) : null}
          </div>
        )}
        {error ? <FieldError role="alert">{error}</FieldError> : null}
      </div>
      <DialogFooter>
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          取消
        </Button>
        <Button
          disabled={pending || selected === null}
          onClick={() => {
            if (selected !== null) onConfirm(selected)
          }}
        >
          {pending ? '正在关联…' : '关联'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

function WindowEditor({
  window,
  groups,
  takenNames,
  licenseStatus,
  onSave,
  onCancel,
}: {
  window: NativeProfile | null
  groups: WindowGroup[]
  takenNames: string[]
  licenseStatus: LicenseStatus | null
  onSave: (
    name: string,
    proxy: string | null,
    proxyPlugin: string | null,
    proxyEndpoint: number | null,
    settings: WindowSettings,
    kernel: KernelSelection,
    groupId?: string | null,
  ) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(window?.name ?? '')
  const [kernel, setKernel] = useState<KernelSelection>({ kind: 'base' })
  const [installedKernels, setInstalledKernels] = useState<InstalledKernel[]>([])
  const [kernelsLoading, setKernelsLoading] = useState(window === null)
  const [kernelsError, setKernelsError] = useState<string | null>(null)
  const [platform, setPlatform] = useState<WindowSettings['platform']>(
    window?.settings.platform ?? 'Vinted',
  )
  const [note, setNote] = useState(window?.settings.note ?? '')
  const [groupId, setGroupId] = useState(window?.groupId ?? 'ungrouped')
  const [config, setConfig] = useState<WindowConfig>(() => configOf(window))
  const [proxySource, setProxySource] = useState<'direct' | 'manual' | 'plugin'>(
    window?.proxyPlugin ? 'plugin' : window?.proxy ? 'manual' : 'direct',
  )
  const [proxyPlugin, setProxyPlugin] = useState<string | null>(
    window?.proxyPlugin ?? null,
  )
  const [endpointId, setEndpointId] = useState<number | null>(
    window?.proxyEndpoint ?? null,
  )
  const [providers, setProviders] = useState<PluginView[]>([])
  const [proxies, setProxies] = useState<ProxyRow[] | null>(null)
  const [defaultProxyId, setDefaultProxyId] = useState<string | null>(null)
  const [proxyLoadError, setProxyLoadError] = useState<string | null>(null)
  const [proxyQuery, setProxyQuery] = useState('')
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null)
  const [checkNote, setCheckNote] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (window !== null || !nativeProfilesAvailable()) return
    let active = true
    void getKernelStatus(true).then(
      (status) => {
        if (!active) return
        setInstalledKernels(status.installed)
        setKernelsLoading(false)
      },
      () => {
        if (!active) return
        setKernelsError('本地版本暂时无法读取')
        setKernelsLoading(false)
      },
    )
    return () => {
      active = false
    }
  }, [window])

  useEffect(() => {
    if (!nativeProfilesAvailable()) return
    let active = true
    void listProxyProviders().then(
      (list) => {
        if (active) {
          setProviders(list.filter((entry) => entry.state === 'running'))
        }
      },
      () => {
        // Without a running provider the editor simply offers the other sources.
      },
    )
    return () => {
      active = false
    }
  }, [])

  // The picker reads the pool itself: a window pins one row, not the default.
  useEffect(() => {
    if (proxySource !== 'plugin' || providers.length === 0) return
    let active = true
    void Promise.all([listProxies({ ...EMPTY_QUERY, limit: 500 }), getConfig()]).then(
      ([result, poolConfig]) => {
        if (active) {
          setProxies(result.items)
          setDefaultProxyId(poolConfig.defaultEndpointId)
          setProxyLoadError(null)
        }
      },
      (cause: unknown) => {
        if (active) {
          setProxies([])
          setProxyLoadError(message(cause))
        }
      },
    )
    return () => {
      active = false
    }
  }, [proxySource, providers.length])

  function patch(changes: Partial<WindowConfig>) {
    setConfig((current) => ({ ...current, ...changes }))
    setError(null)
  }

  const visibleProxies = useMemo(() => {
    if (proxies === null) return []
    const keyword = proxyQuery.trim().toLowerCase()
    if (keyword === '') return proxies
    return proxies.filter((row) =>
      `${row.name} ${row.host}:${row.port}`.toLowerCase().includes(keyword),
    )
  }, [proxies, proxyQuery])

  async function runCheck() {
    setChecking(true)
    setCheckResult(null)
    setCheckNote(null)
    const outcome = await checkWindowProxy(
      proxySource === 'manual'
        ? { proxy: config.proxy.server.trim(), proxyPlugin: null, proxyEndpoint: null }
        : { proxy: null, proxyPlugin, proxyEndpoint: endpointId },
    )
    if (outcome.kind === 'checked') {
      setCheckResult(outcome.result)
      if (outcome.result.ok) toast.success('代理可用')
      else toast.error(outcome.result.error ?? '代理不可用')
    } else {
      setCheckNote(outcome.reason)
      toast.error(outcome.reason)
    }
    setChecking(false)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (name.trim().length > 40 || note.trim().length > 120) {
      setError('窗口名称最多 40 个字符，备注最多 120 个字符。')
      return
    }
    const browserVersion = kernel.version?.trim() ?? ''
    if (browserVersion && !/^\d+(?:\.\d+){3,4}$/.test(browserVersion)) {
      setError('内核版本需要是完整的数字版本号，例如 155.0.1.2。')
      return
    }
    try {
      const checked = parseWindowConfig(config)
      const settings: WindowSettings = {
        platform,
        note: note.trim(),
        geoip: checked.geoip,
        timezone: checked.timezone,
        locale: checked.locale,
        viewport: checked.viewport,
        fingerprintSeed:
          checked.fingerprintSeed ?? (window === null ? randomFingerprintSeed() : null),
        startUrl: checked.startUrl,
      }
      if (proxySource === 'plugin' && proxyPlugin === null) {
        setError('请选择一个已启用的代理插件。')
        return
      }
      if (proxySource === 'plugin' && endpointId === null) {
        setPending(true)
        setError(null)
        const poolConfig = await getConfig()
        if (poolConfig.defaultEndpointId === null) {
          setError('请从代理池选择一条代理；当前未设置默认代理。')
          return
        }
      }
      if (proxySource === 'manual' && checked.proxy.protocol !== 'direct') {
        if (checked.proxy.server.trim() === '') {
          setError('请填写代理地址，或把代理来源改为直连。')
          return
        }
      }
      setPending(true)
      setError(null)
      await onSave(
        // An unnamed window still needs a label: one English word will do.
        name.trim() === '' ? randomWindowName(takenNames) : name.trim(),
        proxySource === 'manual' && checked.proxy.protocol !== 'direct'
          ? checked.proxy.server
          : null,
        proxySource === 'plugin' ? proxyPlugin : null,
        proxySource === 'plugin' ? endpointId : null,
        settings,
        { kind: kernel.kind, ...(browserVersion ? { version: browserVersion } : {}) },
        groupId === 'ungrouped' ? null : groupId,
      )
    } catch (cause) {
      setError(message(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <DialogContent className="window-editor">
      <DialogHeader>
        <DialogTitle>{window ? '编辑窗口' : '创建窗口'}</DialogTitle>
        <DialogDescription>
          {window
            ? `内核 ${majorVersion(window.version)} 已固定；配置在下次打开时生效。`
            : '创建独立浏览器环境。可先在设置的「浏览器内核」中下载所需内核。'}
        </DialogDescription>
      </DialogHeader>
      <form
        id="window-form"
        className="window-form"
        onSubmit={(event) => void submit(event)}
      >
        <div className="grid gap-3">
          <Field>
            <FieldLabel htmlFor="window-name">窗口名称</FieldLabel>
            <Input
              id="window-name"
              autoFocus
              maxLength={40}
              disabled={pending}
              placeholder="留空自动生成，例如 meadow"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {!window ? (
            <WindowKernelPicker
              value={kernel}
              onChange={(selection) => {
                setKernel(selection)
                setError(null)
              }}
              license={licenseStatus}
              installed={installedKernels}
              loading={kernelsLoading}
              error={kernelsError}
              disabled={pending}
            />
          ) : null}
          <div className="window-form-grid">
            <Field>
              <FieldLabel htmlFor="window-platform">平台</FieldLabel>
              <Select
                value={platform}
                disabled={pending}
                onValueChange={(value) => {
                  if (value === 'Vinted' || value === 'Poshmark' || value === '其他') {
                    setPlatform(value)
                  }
                }}
              >
                <SelectTrigger id="window-platform">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Vinted">Vinted</SelectItem>
                  <SelectItem value="Poshmark">Poshmark</SelectItem>
                  <SelectItem value="其他">其他</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="window-note">备注</FieldLabel>
              <Input
                id="window-note"
                maxLength={120}
                disabled={pending}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="window-group">分组</FieldLabel>
            <Select value={groupId} disabled={pending} onValueChange={setGroupId}>
              <SelectTrigger id="window-group">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ungrouped">未分组</SelectItem>
                {groups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <h3>连接与地域</h3>
          <div className="window-form-grid">
            <Field>
              <FieldLabel htmlFor="window-proxy-source">代理来源</FieldLabel>
              <Select
                value={proxySource}
                disabled={pending}
                onValueChange={(value) => {
                  if (value !== 'direct' && value !== 'manual' && value !== 'plugin')
                    return
                  setProxySource(value)
                  setCheckResult(null)
                  setCheckNote(null)
                  if (value === 'direct') {
                    setProxyPlugin(null)
                    setEndpointId(null)
                    patch({ proxy: { protocol: 'direct', server: '' } })
                  } else if (value === 'manual') {
                    setProxyPlugin(null)
                    setEndpointId(null)
                    patch({ proxy: { protocol: 'http', server: '' } })
                  } else {
                    setProxyPlugin(providers[0]?.id ?? null)
                    setEndpointId(null)
                    patch({ proxy: { protocol: 'direct', server: '' } })
                  }
                }}
              >
                <SelectTrigger id="window-proxy-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="direct">直连</SelectItem>
                  <SelectItem value="manual">手动填写</SelectItem>
                  <SelectItem value="plugin">代理池</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {proxySource === 'manual' ? (
              <>
                <Field>
                  <FieldLabel htmlFor="window-protocol">协议</FieldLabel>
                  <Select
                    value={config.proxy.protocol === 'socks5' ? 'socks5' : 'http'}
                    disabled={pending}
                    onValueChange={(value) => {
                      if (value === 'http' || value === 'socks5') {
                        patch({ proxy: { protocol: value, server: config.proxy.server } })
                        setCheckResult(null)
                      }
                    }}
                  >
                    <SelectTrigger id="window-protocol">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="http">HTTP</SelectItem>
                      <SelectItem value="socks5">SOCKS5</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="window-proxy">代理地址</FieldLabel>
                  <Input
                    id="window-proxy"
                    maxLength={200}
                    disabled={pending}
                    placeholder={`${config.proxy.protocol}://host:port`}
                    value={config.proxy.server}
                    onChange={(event) => {
                      patch({ proxy: { ...config.proxy, server: event.target.value } })
                      setCheckResult(null)
                    }}
                  />
                </Field>
              </>
            ) : null}
            {proxySource === 'plugin' ? (
              <Field className="window-proxy-plugin-field">
                <FieldLabel htmlFor="window-proxy-plugin">代理插件</FieldLabel>
                {providers.length === 0 ? (
                  <p className="window-plugin-hint">
                    没有运行中的代理插件。先到「插件中心 → 代理池」启用并添加代理。
                  </p>
                ) : (
                  <Select
                    value={proxyPlugin ?? ''}
                    disabled={pending}
                    onValueChange={(value) => {
                      setProxyPlugin(value)
                      setEndpointId(null)
                      setCheckResult(null)
                    }}
                  >
                    <SelectTrigger id="window-proxy-plugin">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {providers.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            ) : null}
          </div>

          {proxySource === 'plugin' && providers.length > 0 ? (
            <div className="proxy-picker">
              <div className="proxy-picker-head">
                <span>从代理池选择</span>
                <small>{proxies === null ? '加载中…' : `${proxies.length} 条`}</small>
              </div>
              <div className="search-field">
                <Search aria-hidden="true" />
                <Input
                  aria-label="搜索代理"
                  placeholder="搜索名称、主机或端口"
                  value={proxyQuery}
                  onChange={(event) => setProxyQuery(event.target.value)}
                />
              </div>
              <div className="account-picker" role="listbox" aria-label="代理池代理">
                <button
                  type="button"
                  role="option"
                  aria-selected={endpointId === null && defaultProxyId !== null}
                  className="account-option"
                  data-selected={
                    endpointId === null && defaultProxyId !== null ? 'true' : undefined
                  }
                  disabled={pending || proxies === null || defaultProxyId === null}
                  onClick={() => {
                    setEndpointId(null)
                    setCheckResult(null)
                    setError(null)
                  }}
                >
                  <span>
                    <strong>使用插件默认代理</strong>
                    <small>
                      {proxies === null
                        ? '正在读取默认项…'
                        : defaultProxyId === null
                          ? '尚未设置，请选择下方的具体代理'
                          : `跟随默认代理 #${defaultProxyId}`}
                    </small>
                  </span>
                  {endpointId === null && defaultProxyId !== null ? (
                    <Check aria-hidden="true" />
                  ) : null}
                </button>
                {visibleProxies.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    role="option"
                    aria-selected={endpointId === Number(row.id)}
                    className="account-option"
                    data-selected={endpointId === Number(row.id) ? 'true' : undefined}
                    disabled={pending || !row.enabled}
                    onClick={() => {
                      setEndpointId(Number(row.id))
                      setCheckResult(null)
                      setError(null)
                    }}
                  >
                    <span>
                      <strong>
                        {flagOf(row.geo?.countryCode ?? null)} {row.name}
                      </strong>
                      <small>
                        {row.schemes.map((scheme) => scheme.toUpperCase()).join(' / ')} ·{' '}
                        {row.host}:{row.port}
                        {!row.enabled ? ' · 已停用' : ''}
                        {row.checkStatus === 'ok' ? ' · 上次检测通过' : ''}
                      </small>
                    </span>
                    {endpointId === Number(row.id) ? <Check aria-hidden="true" /> : null}
                  </button>
                ))}
                {proxies !== null && visibleProxies.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {proxyLoadError
                      ? `代理池读取失败：${proxyLoadError}`
                      : proxyQuery.trim()
                        ? '没有匹配的代理。'
                        : '代理池还没有代理。'}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          {proxySource !== 'direct' ? (
            <div className="proxy-check-block">
              <div className="proxy-check-actions">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    pending ||
                    checking ||
                    (proxySource === 'manual' && config.proxy.server.trim() === '')
                  }
                  onClick={() => void runCheck()}
                >
                  {checking ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <ShieldCheck data-icon="inline-start" />
                  )}
                  {checking ? '检测中…' : '检测代理'}
                </Button>
                <span className="proxy-check-hint">
                  使用代理池插件的检测逻辑；不可用时会说明原因。
                </span>
              </div>
              {checkResult === null ? null : <ProxyCheckSummary result={checkResult} />}
              {checkNote === null ? null : (
                <p className="proxy-check-error" role="alert">
                  {checkNote}
                </p>
              )}
            </div>
          ) : null}

          <Field className="window-switch-field" orientation="horizontal">
            <FieldLabel htmlFor="window-geoip">
              通过代理 IP 匹配时区、语言和 WebRTC IP
            </FieldLabel>
            <Switch
              id="window-geoip"
              disabled={pending}
              checked={config.geoip}
              onCheckedChange={(checked) => patch({ geoip: checked })}
            />
          </Field>
          {proxySource === 'direct' ? (
            <p className="text-xs text-muted-foreground">
              直连时保留自动匹配偏好但不生效；配置代理后才按代理出口匹配。
            </p>
          ) : null}
          <div className="window-form-grid">
            <Field>
              <FieldLabel htmlFor="window-timezone">时区覆盖</FieldLabel>
              <Input
                id="window-timezone"
                maxLength={64}
                disabled={pending}
                placeholder="默认 / America/New_York"
                value={config.timezone}
                onChange={(event) => patch({ timezone: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="window-locale">语言覆盖</FieldLabel>
              <Input
                id="window-locale"
                maxLength={35}
                disabled={pending}
                placeholder="默认 / en-US"
                value={config.locale}
                onChange={(event) => patch({ locale: event.target.value })}
              />
            </Field>
          </div>
          <h3>浏览器环境</h3>
          <div className="window-form-grid">
            <Field>
              <FieldLabel htmlFor="window-viewport">窗口尺寸</FieldLabel>
              <Select
                value={config.viewport}
                disabled={pending}
                onValueChange={(value) => {
                  if (
                    value === 'default' ||
                    value === '1440x900' ||
                    value === '1920x1080'
                  ) {
                    patch({ viewport: value })
                  }
                }}
              >
                <SelectTrigger id="window-viewport">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">浏览器默认</SelectItem>
                  <SelectItem value="1440x900">1440 × 900</SelectItem>
                  <SelectItem value="1920x1080">1920 × 1080</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="window-seed">指纹种子</FieldLabel>
              <div className="seed-field">
                <Input
                  id="window-seed"
                  inputMode="numeric"
                  disabled={pending || !!window}
                  placeholder="自动保持"
                  value={config.fingerprintSeed ?? ''}
                  onChange={(event) =>
                    patch({
                      fingerprintSeed:
                        event.target.value === '' ? null : Number(event.target.value),
                    })
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="随机生成指纹种子"
                  disabled={pending || !!window}
                  onClick={() => patch({ fingerprintSeed: randomFingerprintSeed() })}
                >
                  <Dices />
                </Button>
              </div>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="window-url">起始地址</FieldLabel>
            <Input
              id="window-url"
              type="url"
              maxLength={2048}
              disabled={pending}
              placeholder="https://example.com"
              value={config.startUrl}
              onChange={(event) => patch({ startUrl: event.target.value })}
            />
          </Field>
          {error ? <FieldError role="alert">{error}</FieldError> : null}
        </div>
      </form>
      <DialogFooter>
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" form="window-form" disabled={pending}>
          {pending
            ? window
              ? '正在保存…'
              : '正在准备内核…'
            : window
              ? '保存窗口'
              : '创建窗口'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
