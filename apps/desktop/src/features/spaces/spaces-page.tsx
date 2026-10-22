import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  ArrowUpRight,
  Check,
  Ellipsis,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
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
  unbindWindow,
} from '@/features/accounts/api'
import {
  ACCOUNTS_PLUGIN_ID,
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
  operateNativeProfile,
  updateNativeProfile,
  type NativeProfile,
  type WindowSettings,
} from '@/lib/platform/native-profiles'
import {
  canPinBrowserVersion,
  getLicenseStatus,
  type LicenseStatus,
} from '@/lib/platform/native-license'
import { DEFAULT_WINDOW_CONFIG, parseWindowConfig, type WindowConfig } from '@/demo/model'

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
  const [operatingWindows, setOperatingWindows] = useState<Set<string>>(() => new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [accountHost, setAccountHost] = useState<PluginView | null>(null)
  const [bindings, setBindings] = useState<BindingView[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [binding, setBinding] = useState<NativeProfile | null>(null)
  const [conflict, setConflict] = useState<{
    window: NativeProfile
    accountId: string
    duplicates: string[]
  } | null>(null)
  const [bindingError, setBindingError] = useState<string | null>(null)
  const [bindingPending, setBindingPending] = useState(false)

  const load = useCallback(async () => {
    const records = await listNativeProfiles()
    setWindows(records)
  }, [])

  async function refresh() {
    if (refreshing) return
    setRefreshing(true)
    try {
      const [records, currentGroups] = await Promise.all([
        listNativeProfiles(),
        listGroups(),
      ])
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

  const accountsRunning = accountHost !== null && accountHost.state === 'running'

  useEffect(() => {
    if (!native) return
    let active = true
    void listPlugins().then(
      (catalog) => {
        if (active) {
          setAccountHost(catalog.find((entry) => entry.id === ACCOUNTS_PLUGIN_ID) ?? null)
        }
      },
      () => {
        // Without a catalog the account column simply stays empty.
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
          setAccountHost(catalog.find((entry) => entry.id === ACCOUNTS_PLUGIN_ID) ?? null)
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

  async function operate(window: NativeProfile) {
    setOperatingWindows((current) => new Set(current).add(window.id))
    setError(null)
    try {
      await operateNativeProfile(window.id, window.running)
      await load()
    } catch (cause) {
      setError(message(cause))
      try {
        await load()
      } catch {
        // Keep the operation error visible; the user can refresh explicitly.
      }
    } finally {
      setOperatingWindows((current) => {
        const next = new Set(current)
        next.delete(window.id)
        return next
      })
    }
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
  const target = windows.find((window) => window.id === deleting)

  return (
    <section className="collection-page page-reveal" aria-labelledby="spaces-heading">
      <div className="section-intro">
        <div>
          <h1 className="page-heading" id="spaces-heading">
            窗口管理
          </h1>
          <p className="page-description">管理窗口配置与运行状态。</p>
        </div>
        <div className="flex items-center gap-2">
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
      <div className="collection-toolbar">
        <span className="result-count">{visible.length} 个窗口</span>
        {native ? (
          <span className="result-count">
            {windows.filter((window) => window.running).length} 个运行中
          </span>
        ) : null}
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
      </div>
      <div className="space-table-panel">
        <div className="panel-heading">
          <h2>全部窗口</h2>
          <Badge variant="secondary">{windows.length}</Badge>
        </div>
        <Table aria-label="窗口列表">
          <TableHeader>
            <TableRow>
              <TableHead>窗口名称</TableHead>
              <TableHead>平台</TableHead>
              <TableHead>Vinted 账号</TableHead>
              <TableHead>分组</TableHead>
              <TableHead>内核版本</TableHead>
              <TableHead>代理</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((window) => {
              const bound = bindingOf(window.id)
              return (
                <TableRow key={window.id}>
                  <TableCell>
                    <strong>{window.name}</strong>
                    <small className="block text-muted-foreground">
                      {window.settings.note}
                    </small>
                  </TableCell>
                  <TableCell>{window.settings.platform}</TableCell>
                  <TableCell>
                    {bound === null ? (
                      <span className="text-muted-foreground">未关联</span>
                    ) : (
                      <span className="account-cell">
                        <strong>{bound.account?.account ?? '账号已删除'}</strong>
                        <small className="block text-muted-foreground">
                          {bound.account ? STATUS_LABELS[bound.account.status] : ''}
                        </small>
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {groups.find((group) => group.id === window.groupId)?.name ??
                      '未分组'}
                  </TableCell>
                  <TableCell>{window.version}</TableCell>
                  <TableCell>{window.proxy ?? '直连'}</TableCell>
                  <TableCell>{window.running ? '运行中' : '已停止'}</TableCell>
                  <TableCell>
                    <div className="table-actions">
                      <Button
                        variant={window.running ? 'outline' : 'default'}
                        size="sm"
                        disabled={operatingWindows.has(window.id)}
                        onClick={() => void operate(window)}
                      >
                        {window.running ? (
                          <Square data-icon="inline-start" />
                        ) : (
                          <Play data-icon="inline-start" />
                        )}
                        {window.running ? '停止' : '打开'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`编辑 ${window.name}`}
                        disabled={window.running || operatingWindows.has(window.id)}
                        onClick={() => setEditing(window.id)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setViewing(window.id)}
                      >
                        详情 <ArrowUpRight data-icon="inline-end" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`删除 ${window.name}`}
                        disabled={window.running || operatingWindows.has(window.id)}
                        onClick={() => setDeleting(window.id)}
                      >
                        <Trash2 />
                      </Button>
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
                            {bound === null ? '关联账号' : '更换账号'}
                          </DropdownMenuItem>
                          {bound === null ? null : (
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
            onSave={async (
              name,
              proxy,
              proxyPlugin,
              settings,
              browserVersion,
              groupId,
            ) => {
              if (editing === 'new') {
                const created = await createNativeProfile(
                  name,
                  proxy,
                  proxyPlugin,
                  settings,
                  browserVersion,
                  groupId,
                )
                setWindows((current) => [...current, created])
              } else {
                await updateNativeProfile(
                  editing,
                  name,
                  proxy,
                  proxyPlugin,
                  settings,
                  groupId,
                )
                await load()
              }
              setEditing(null)
            }}
            canPinBrowserVersion={canPinBrowserVersion(
              licenseStatus ?? { configured: false, plan: null, expires: null },
            )}
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
                独立浏览器环境 · 内核 {selected.version}
              </DialogDescription>
            </DialogHeader>
            <dl className="about-details">
              <div className="about-row">
                <dt>平台</dt>
                <dd>{selected.settings.platform}</dd>
              </div>
              <div className="about-row">
                <dt>Vinted 账号</dt>
                <dd>{bindingOf(selected.id)?.account?.account ?? '未关联'}</dd>
              </div>
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
                <dd>{selected.proxy ?? '直连'}</dd>
              </div>
              <div className="about-row">
                <dt>GeoIP</dt>
                <dd>{selected.settings.geoip ? '启用' : '关闭'}</dd>
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
            还没有账号。先到「Vinted 账号」页新增或导入。
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
  canPinBrowserVersion: canPinVersion,
  onSave,
  onCancel,
}: {
  window: NativeProfile | null
  groups: WindowGroup[]
  canPinBrowserVersion: boolean
  onSave: (
    name: string,
    proxy: string | null,
    proxyPlugin: string | null,
    settings: WindowSettings,
    browserVersion?: string,
    groupId?: string | null,
  ) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(window?.name ?? '')
  const [browserVersion, setBrowserVersion] = useState('')
  const [platform, setPlatform] = useState<WindowSettings['platform']>(
    window?.settings.platform ?? 'Vinted',
  )
  const [note, setNote] = useState(window?.settings.note ?? '')
  const [groupId, setGroupId] = useState(window?.groupId ?? 'ungrouped')
  const [config, setConfig] = useState<WindowConfig>(() => ({
    ...DEFAULT_WINDOW_CONFIG,
    ...window?.settings,
    proxy: window?.proxy
      ? {
          protocol: window.proxy.startsWith('socks5://') ? 'socks5' : 'http',
          server: window.proxy,
        }
      : { protocol: 'direct', server: '' },
  }))
  const [proxySource, setProxySource] = useState<'direct' | 'manual' | 'plugin'>(
    window?.proxyPlugin ? 'plugin' : window?.proxy ? 'manual' : 'direct',
  )
  const [proxyPlugin, setProxyPlugin] = useState<string | null>(
    window?.proxyPlugin ?? null,
  )
  const [providers, setProviders] = useState<PluginView[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
  function patch(changes: Partial<WindowConfig>) {
    setConfig((current) => ({ ...current, ...changes }))
    setError(null)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim() || name.trim().length > 40 || note.trim().length > 120) {
      setError('窗口名称需要包含 1 至 40 个字符，备注最多 120 个字符。')
      return
    }
    if (browserVersion.trim() && !/^\d+(?:\.\d+){3,4}$/.test(browserVersion.trim())) {
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
        fingerprintSeed: checked.fingerprintSeed,
        startUrl: checked.startUrl,
      }
      if (proxySource === 'plugin' && proxyPlugin === null) {
        setError('请选择一个已启用的代理插件。')
        return
      }
      setPending(true)
      setError(null)
      await onSave(
        name.trim(),
        proxySource === 'manual' && checked.proxy.protocol !== 'direct'
          ? checked.proxy.server
          : null,
        proxySource === 'plugin' ? proxyPlugin : null,
        settings,
        browserVersion.trim() || undefined,
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
            ? `内核 ${window.version} 已固定；配置在下次打开时生效。`
            : '创建独立浏览器环境。创建后才会下载或准备所需内核。'}
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
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {!window && canPinVersion ? (
            <Field>
              <FieldLabel htmlFor="window-browser-version">Chromium 版本</FieldLabel>
              <Input
                id="window-browser-version"
                inputMode="numeric"
                autoComplete="off"
                disabled={pending}
                placeholder="留空使用可用的最新内核"
                value={browserVersion}
                onChange={(event) => setBrowserVersion(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                支持完整版本号，例如 155.0.1.2；创建后版本固定。
              </p>
            </Field>
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
                  if (value === 'direct') {
                    setProxyPlugin(null)
                    patch({ proxy: { protocol: 'direct', server: '' }, geoip: false })
                  } else if (value === 'manual') {
                    setProxyPlugin(null)
                    patch({ proxy: { protocol: 'http', server: '' } })
                  } else {
                    setProxyPlugin(providers[0]?.id ?? null)
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
                  <SelectItem value="plugin">代理池插件</SelectItem>
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
                    onChange={(event) =>
                      patch({ proxy: { ...config.proxy, server: event.target.value } })
                    }
                  />
                </Field>
              </>
            ) : null}
            {proxySource === 'plugin' ? (
              <Field>
                <FieldLabel htmlFor="window-proxy-plugin">代理插件</FieldLabel>
                {providers.length === 0 ? (
                  <p className="window-plugin-hint">
                    没有运行中的代理插件。先到插件中心启用「代理池」并选择默认代理。
                  </p>
                ) : (
                  <Select
                    value={proxyPlugin ?? ''}
                    disabled={pending}
                    onValueChange={setProxyPlugin}
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
          <Field className="window-switch-field" orientation="horizontal">
            <FieldLabel htmlFor="window-geoip">
              通过代理 IP 匹配时区、语言和 WebRTC IP
            </FieldLabel>
            <Switch
              id="window-geoip"
              disabled={pending || proxySource === 'direct'}
              checked={config.geoip}
              onCheckedChange={(checked) => patch({ geoip: checked })}
            />
          </Field>
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
