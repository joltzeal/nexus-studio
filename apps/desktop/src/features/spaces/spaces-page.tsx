import type { Dispatch, SetStateAction } from 'react'
import {
  BROWSER_PROVIDERS,
  listBrowserConnections,
  type BrowserConnection,
  type BrowserProviderId,
} from '@/lib/platform/browser-connections'
import { BrowserConnectionsPage } from '@/features/settings/browser-connections-page'
import { BrowserOperationRecovery } from './browser-operation-recovery'
import type { CreateBrowserWindowInput } from '@nexus/contracts/browser'
import { AttachWindowDialog } from './attach-window-dialog'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { navigateDetail, useDetailNavigation } from '@/lib/detail-navigation'
import {
  ArrowUpRight,
  Check,
  ClipboardList,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Ellipsis,
  FolderInput,
  Loader2,
  PanelsTopLeft,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toast'
import {
  Select,
  SelectContent,
  SelectGroup,
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
import { listPlugins, type PluginView } from '@/lib/platform/native-plugins'
import { AccountEditor } from '@/features/accounts/account-editor'
import { updateContact } from '@/features/sim8/accounts-bridge'
import {
  bindAccount,
  listAccounts,
  listBindings,
  saveAccount,
  unbindWindow,
} from '@/features/accounts/api'
import {
  ACCOUNTS_PLUGIN_ID,
  ACCOUNT_STATUSES,
  EMPTY_ACCOUNT,
  LOGIN_METHOD_LABELS,
  STATUS_LABELS,
  statusVariant,
  type Account,
  type BindingView,
} from '@/features/accounts/types'
import { listGroups, type WindowGroup } from '@/lib/platform/native-groups'
import {
  createBrowserWindow,
  deleteBrowserWindow,
  listBrowserWindows,
  browserWindowsAvailable,
  orderBrowserWindows,
  moveBrowserWindowsGroup,
  updateBrowserWindow,
  type BrowserWindow,
} from '@/lib/platform/windows'
import { getLicenseStatus, type LicenseStatus } from '@/lib/platform/native-license'
import { WindowEditor } from './window-editor'
import { BatchWindowDialog } from './batch-window-dialog'
import { mergeBatchWindows } from './window-batch'
import { formatAbsolute, formatRelative, majorVersion } from '@/lib/format-time'
import { hasProxy } from './window-proxy'
import { ProxyGateDialog } from './proxy-gate'
import { TransferToolbar } from './transfer-toolbar'
import { TransferRecoveryNotice } from './transfer-recovery'
import { useTransferRecovery } from './use-transfer-recovery'
import { toggleSelection, withDeadline } from './transfer-state'
import { useWindowLaunch } from './use-window-launch'
import { WindowNote } from './window-note'
import { AccountPhoneCopy, AccountSmsPopover } from './account-sms-popover'
import { AccountSmsWaitButton } from './account-sms-wait-button'
import { smsWaits } from '@/features/accounts/sms-wait-runtime'
import { Sim8ExpiryNotice } from '@/features/sim8/expiry-notice'

const WINDOW_PAGE_SIZES = [20, 50, 100] as const

function message(error: unknown): string {
  return typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '操作失败，请重试。'
}

export function SpacesPage() {
  const [expiryRefreshKey, setExpiryRefreshKey] = useState(0)
  const native = browserWindowsAvailable()
  const [windows, setWindows] = useState<BrowserWindow[]>([])
  const [connections, setConnections] = useState<BrowserConnection[]>([])
  const [providerId, setProviderId] = useState<BrowserProviderId>('cloakbrowser')
  const [attaching, setAttaching] = useState(false)
  const [managingConnections, setManagingConnections] = useState(false)
  const connection =
    connections.find((entry) => entry.providerId === providerId && entry.enabled) ?? null
  const connectionId = connection?.id ?? null
  const createIntent = useRef<CreateBrowserWindowInput | null>(null)
  const viewEpoch = useRef(0)
  const selectionScope = useRef(connectionId)
  const connectionSnapshot = useRef('')
  const connectionRequest = useRef(0)
  const windowReads = useRef({
    request: 0,
    revision: 0,
    active: true,
    latest: null as Promise<BrowserWindow[]> | null,
  })
  const applyWindows: Dispatch<SetStateAction<BrowserWindow[]>> = useCallback(
    (update) => {
      windowReads.current.revision += 1
      setWindows(update)
    },
    [],
  )
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null)
  const [groups, setGroups] = useState<WindowGroup[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<(typeof WINDOW_PAGE_SIZES)[number]>(20)
  const [filters, setFilters] = useState<
    Record<string, { group: string; account: string; query: string }>
  >({})
  const filterKey = connectionId ?? providerId
  const currentFilters = filters[filterKey] ?? { group: 'all', account: 'all', query: '' }
  const { group: groupFilter, account: accountFilter, query } = currentFilters
  const setGroupFilter = (group: string) => {
    setPage(1)
    setFilters((current) => ({
      ...current,
      [filterKey]: {
        ...(current[filterKey] ?? { group: 'all', account: 'all', query: '' }),
        group,
      },
    }))
  }
  const setAccountFilter = (account: string) => {
    setPage(1)
    setFilters((current) => ({
      ...current,
      [filterKey]: {
        ...(current[filterKey] ?? { group: 'all', account: 'all', query: '' }),
        account,
      },
    }))
  }
  const setQuery = (query: string) => {
    setPage(1)
    setFilters((current) => ({
      ...current,
      [filterKey]: {
        ...(current[filterKey] ?? { group: 'all', account: 'all', query: '' }),
        query,
      },
    }))
  }
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [batchCreating, setBatchCreating] = useState(false)
  const [viewing, setViewing] = useState<string | null>(null)
  const [detailWindowId, setDetailWindowId] = useState<string | null>(null)
  useDetailNavigation(
    'window',
    useCallback((request) => {
      setDetailWindowId(request.id)
    }, []),
  )
  useEffect(() => {
    if (!detailWindowId || windows.length === 0 || connections.length === 0) return
    let active = true
    // Initial connection refresh can reset open dialogs; resolve the link after it settles.
    queueMicrotask(() => {
      if (!active) return
      const target = windows.find((item) => item.id === detailWindowId)
      if (!target) {
        toast.error('该窗口已不存在，请刷新窗口列表。')
        setDetailWindowId(null)
        return
      }
      if (providerId !== target.providerId) {
        setProviderId(target.providerId)
        return
      }
      if (connection?.id !== target.connectionId) {
        toast.error('该窗口所属的浏览器接入尚未启用，请先检查应用设置。')
        setDetailWindowId(null)
        return
      }
      setViewing(target.id)
      setDetailWindowId(null)
    })
    return () => {
      active = false
    }
  }, [windows, connections, providerId, connection?.id, detailWindowId])
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteEnvironment, setDeleteEnvironment] = useState(true)
  const deletingRequest = useRef(false)
  const [deletePending, setDeletePending] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [groupMove, setGroupMove] = useState<{
    connectionId: string
    ids: string[]
    epoch: number
    destination: string
  } | null>(null)
  const [groupMovePending, setGroupMovePending] = useState(false)
  const [groupMoveError, setGroupMoveError] = useState<string | null>(null)
  const groupMoveRequest = useRef(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [accountPlugin, setAccountPlugin] = useState<PluginView | null>(null)
  const [bindings, setBindings] = useState<BindingView[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountDataReady, setAccountDataReady] = useState(false)
  const [accountGeneration, setAccountGeneration] = useState(0)
  const accountSync = useRef({
    available: false,
    ready: false,
    generation: 0,
    request: 0,
    revision: 0,
  })
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [unlinkingPhones, setUnlinkingPhones] = useState<Set<string>>(() => new Set())
  const phoneUnlinkRequests = useRef(new Set<string>())
  const [binding, setBinding] = useState<BrowserWindow | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [conflict, setConflict] = useState<{
    window: BrowserWindow
    accountId: string
    duplicates: string[]
  } | null>(null)
  const [bindingError, setBindingError] = useState<string | null>(null)
  const [bindingPending, setBindingPending] = useState(false)
  const bindingSession = useRef(0)
  const bindingRequest = useRef<number | null>(null)
  const dismissBinding = useCallback(() => {
    bindingSession.current += 1
    setBinding(null)
    setConflict(null)
    setBindingError(null)
    setBindingPending(false)
  }, [])
  const recovery = useTransferRecovery(native)

  const load = useCallback((): Promise<BrowserWindow[]> => {
    const state = windowReads.current
    const request = ++state.request
    let revision = state.revision
    async function read(): Promise<BrowserWindow[]> {
      while (state.active) {
        const records = await withDeadline(
          listBrowserWindows(),
          10_000,
          '读取窗口列表超时，请重试刷新。',
        )
        if (!state.active) return []
        // Action confirmation must observe the same latest snapshot as the table.
        if (request !== state.request) return state.latest ?? []
        if (revision !== state.revision) {
          revision = state.revision
          continue
        }
        setWindows(records)
        return records
      }
      return []
    }
    state.latest = read()
    return state.latest
  }, [])
  const loadConnections = useCallback(async () => {
    const request = ++connectionRequest.current
    const items = await listBrowserConnections()
    if (request === connectionRequest.current && windowReads.current.active) {
      const snapshot = items
        .filter((entry) => entry.enabled)
        .map((entry) => `${entry.id}:${entry.revision}`)
        .sort()
        .join('|')
      if (snapshot !== connectionSnapshot.current) {
        connectionSnapshot.current = snapshot
        viewEpoch.current += 1
        selectionScope.current = null
        setPage(1)
        setSelectedIds(new Set())
        setGroupMove(null)
        setEditing(null)
        setBatchCreating(false)
        setViewing(null)
        setDeleting(null)
        setAttaching(false)
        dismissBinding()
        setEditingAccount(null)
      }
      setConnections(items)
    }
  }, [dismissBinding])
  const {
    gate,
    operatingWindows,
    startingWindows,
    unconfirmedWindows,
    open,
    stop,
    refreshGate,
    closeGate,
  } = useWindowLaunch(load, setError, connectionId, connection?.revision ?? 0)

  function changeProvider(value: string) {
    if (
      !BROWSER_PROVIDERS.some((provider) => provider.id === value) ||
      value === providerId
    )
      return
    viewEpoch.current += 1
    selectionScope.current =
      connections.find((entry) => entry.providerId === value && entry.enabled)?.id ?? null
    setProviderId(value as BrowserProviderId)
    setPage(1)
    setSelectedIds(new Set())
    setGroupMove(null)
    setEditing(null)
    setBatchCreating(false)
    setViewing(null)
    setDeleting(null)
    setAttaching(false)
    dismissBinding()
    setEditingAccount(null)
    setError(null)
    closeGate()
  }

  useEffect(() => {
    selectionScope.current = connectionId
  }, [connectionId])

  async function refresh() {
    if (refreshing) return
    setExpiryRefreshKey((value) => value + 1)
    recovery.retry()
    setRefreshing(true)
    const epoch = viewEpoch.current
    try {
      const [, currentGroups, license] = await withDeadline(
        Promise.all([
          load(),
          listGroups(),
          getLicenseStatus().catch(() => null),
          loadConnections(),
        ]),
        10_000,
        '刷新窗口和分组超时，请重试。',
      )
      if (epoch !== viewEpoch.current) return
      setGroups(currentGroups)
      setLicenseStatus(license)
      await refreshBindings()
      if (epoch === viewEpoch.current) setError(null)
    } catch (cause) {
      if (epoch === viewEpoch.current) setError(message(cause))
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
    const reads = windowReads.current
    reads.active = true
    if (native) {
      void Promise.all([load(), loadConnections()]).catch((cause: unknown) => {
        if (windowReads.current.active) setError(message(cause))
      })
    }
    return () => {
      reads.active = false
      reads.request += 1
      connectionRequest.current += 1
    }
  }, [native, load, loadConnections])

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
  const accountsRunning = native && accountsInstalled && accountPlugin.state === 'running'
  const accountsReady = accountsRunning && accountDataReady

  useEffect(() => {
    if (!native) return
    let active = true
    let pending = false
    const sync = accountSync.current
    function updatePlugin(plugin: PluginView | null) {
      const available = plugin?.state === 'running'
      if (sync.available !== available) {
        sync.available = available
        sync.generation += 1
        setAccountGeneration(sync.generation)
        sync.ready = false
        setAccountDataReady(false)
      }
      setAccountPlugin(plugin)
    }
    async function refreshAccountPlugin() {
      if (pending) return
      pending = true
      try {
        const catalog = await listPlugins()
        if (active) {
          const plugin = catalog.find((entry) => entry.id === ACCOUNTS_PLUGIN_ID) ?? null
          updatePlugin(plugin)
        }
      } catch {
        if (active) updatePlugin(null)
      } finally {
        pending = false
      }
    }
    void refreshAccountPlugin()
    // Keep observing availability so a stopped plugin cannot leave stale filters.
    const timer = setInterval(() => void refreshAccountPlugin(), 3000)
    return () => {
      active = false
      clearInterval(timer)
      sync.available = false
      sync.ready = false
      sync.generation += 1
    }
  }, [native])

  const refreshBindings = useCallback(async () => {
    const sync = accountSync.current
    if (!accountsRunning || !sync.available) return
    const generation = sync.generation
    const request = ++sync.request
    const current = () =>
      sync.available && sync.generation === generation && sync.request === request
    while (current()) {
      const revision = sync.revision
      try {
        const [bound, catalog] = await Promise.all([listBindings(), listAccounts()])
        if (!current()) return
        // A completed write makes this snapshot stale; keep its local result and reread.
        if (sync.revision !== revision) continue
        setBindings(bound.items)
        setAccounts(catalog.items)
        sync.ready = true
        setAccountDataReady(true)
        return
      } catch (cause) {
        if (!current()) return
        if (sync.revision !== revision) continue
        sync.ready = false
        setAccountDataReady(false)
        throw cause
      }
    }
  }, [accountsRunning])

  function applySavedAccount(saved: Account) {
    const previous = accounts.find((account) => account.id === saved.id)
    if (previous?.phone !== saved.phone || previous.smsOtpUrl !== saved.smsOtpUrl) {
      smsWaits.stop(saved.id)
    }
    accountSync.current.revision += 1
    setAccounts((current) =>
      current.some((account) => account.id === saved.id)
        ? current.map((account) => (account.id === saved.id ? saved : account))
        : [...current, saved],
    )
    setBindings((current) =>
      current.map((binding) =>
        binding.accountId === saved.id
          ? {
              ...binding,
              account: {
                id: saved.id,
                account: saved.account,
                loginMethod: saved.loginMethod,
                status: saved.status,
                note: saved.note,
              },
            }
          : binding,
      ),
    )
  }

  async function refreshAfterBinding() {
    accountSync.current.revision += 1
    await refreshBindings()
  }

  async function unlinkPhone(accountId: string) {
    if (
      !accountsReady ||
      !accountSync.current.ready ||
      phoneUnlinkRequests.current.has(accountId)
    )
      return
    phoneUnlinkRequests.current.add(accountId)
    smsWaits.stop(accountId)
    setUnlinkingPhones(new Set(phoneUnlinkRequests.current))
    try {
      const saved = await updateContact(accountId, { phone: '', smsOtpUrl: '' })
      applySavedAccount(saved)
      toast.success('手机号与短信接码链接已解绑')
    } catch (cause) {
      toast.error(`解绑手机号失败：${message(cause)}`)
    } finally {
      phoneUnlinkRequests.current.delete(accountId)
      setUnlinkingPhones(new Set(phoneUnlinkRequests.current))
    }
  }

  async function refreshAfterImport() {
    const epoch = viewEpoch.current
    const [, currentGroups] = await withDeadline(
      Promise.all([load(), listGroups()]),
      10_000,
      '刷新窗口和分组超时',
    )
    if (epoch !== viewEpoch.current) return
    setGroups(currentGroups)
    setPage(1)
    setSelectedIds(new Set())
    await withDeadline(refreshBindings(), 10_000, '刷新账号关联超时')
  }

  async function moveSelectedGroup(event: FormEvent) {
    event.preventDefault()
    if (
      !native ||
      !groupMove ||
      groupMove.epoch !== viewEpoch.current ||
      groupMoveRequest.current
    )
      return
    const snapshot = groupMove
    groupMoveRequest.current = true
    setGroupMovePending(true)
    setGroupMoveError(null)
    try {
      const result = await moveBrowserWindowsGroup({
        connectionId: snapshot.connectionId,
        ids: snapshot.ids,
        groupId: snapshot.destination === 'ungrouped' ? null : snapshot.destination,
      })
      if (!windowReads.current.active) return
      const moved = new Set(result.ids)
      // A completed local write remains true even if the user changed browser tabs.
      applyWindows((current) =>
        current.map((window) =>
          window.connectionId === result.connectionId && moved.has(window.id)
            ? { ...window, groupId: result.groupId }
            : window,
        ),
      )
      if (snapshot.epoch !== viewEpoch.current) return
      setSelectedIds((current) => toggleSelection(current, result.ids, false))
      setGroupMove(null)
      toast.success(`已移动 ${result.ids.length} 个窗口`)
    } catch (cause) {
      if (windowReads.current.active && snapshot.epoch === viewEpoch.current)
        setGroupMoveError(message(cause))
    } finally {
      groupMoveRequest.current = false
      if (windowReads.current.active) setGroupMovePending(false)
    }
  }

  useEffect(() => {
    if (!accountsRunning) return
    void refreshBindings().catch(() => undefined)
  }, [accountGeneration, accountsRunning, refreshBindings])

  async function bind(window: BrowserWindow, accountId: string | null) {
    const session = bindingSession.current
    if (
      !accountsReady ||
      !accountSync.current.ready ||
      bindingRequest.current === session
    )
      return
    const epoch = viewEpoch.current
    const current = () =>
      session === bindingSession.current &&
      epoch === viewEpoch.current &&
      windowReads.current.active
    bindingRequest.current = session
    const previous = bindings.find((entry) => entry.windowId === window.id)?.accountId
    if (previous && previous !== accountId) smsWaits.stopWindow(window.id)
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
          if (current()) setConflict({ window, accountId, duplicates: result.duplicates })
          return
        }
        toast.success('已关联账号')
      }
      await refreshAfterBinding()
      if (current()) dismissBinding()
    } catch (cause) {
      if (current()) setBindingError(message(cause))
    } finally {
      if (bindingRequest.current === session) bindingRequest.current = null
      if (current()) setBindingPending(false)
    }
  }

  async function confirmDuplicate() {
    const session = bindingSession.current
    if (
      conflict === null ||
      !accountsReady ||
      !accountSync.current.ready ||
      bindingRequest.current === session
    )
      return
    const epoch = viewEpoch.current
    const current = () =>
      session === bindingSession.current &&
      epoch === viewEpoch.current &&
      windowReads.current.active
    bindingRequest.current = session
    setBindingPending(true)
    setBindingError(null)
    try {
      await bindAccount(conflict.accountId, conflict.window.id, true)
      await refreshAfterBinding()
      toast.success('已关联账号')
      if (current()) dismissBinding()
    } catch (cause) {
      if (current()) {
        setBindingError(message(cause))
        setConflict(null)
      }
    } finally {
      if (bindingRequest.current === session) bindingRequest.current = null
      if (current()) setBindingPending(false)
    }
  }

  function bindingOf(windowId: string): BindingView | null {
    // An absent binding is meaningful only after both account lists have loaded.
    if (!accountsReady) return null
    return bindings.find((entry) => entry.windowId === windowId) ?? null
  }

  function accountSummaryOf(binding: BindingView | null): BindingView['account'] {
    if (binding === null) return null
    return (
      accounts.find((account) => account.id === binding.accountId) ??
      (binding.account?.id === binding.accountId ? binding.account : null)
    )
  }

  function matchesAccountFilter(windowId: string): boolean {
    if (!accountsReady || accountFilter === 'all') return true
    const binding = bindingOf(windowId)
    if (accountFilter === 'unbound') return binding === null
    return accountSummaryOf(binding)?.status === accountFilter
  }

  /** The plugin stores opaque window ids; only this page knows their names. */
  function windowName(id: string): string {
    return windows.find((entry) => entry.id === id)?.name ?? id
  }

  function accountLabel(id: string): string {
    return accounts.find((entry) => entry.id === id)?.account ?? id
  }

  function isWindowBusy(window: BrowserWindow): boolean {
    return (
      operatingWindows.has(window.id) ||
      window.state === 'starting' ||
      window.state === 'stopping' ||
      (window.state !== 'running' && startingWindows.has(window.id))
    )
  }

  const connectionWindows = windows.filter(
    (window) => window.connectionId === connectionId,
  )
  const visible = orderBrowserWindows(connectionWindows).filter(
    (window) =>
      (groupFilter === 'all' ||
        (groupFilter === 'ungrouped'
          ? !window.groupId
          : window.groupId === groupFilter)) &&
      `${window.name} ${window.settings.platform} ${window.settings.note} ${window.version} ${window.proxy ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      matchesAccountFilter(window.id),
  )
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  if (currentPage !== page) setPage(currentPage)
  const pageOffset = (currentPage - 1) * pageSize
  const pageWindows = visible.slice(pageOffset, pageOffset + pageSize)
  const selected = connectionWindows.find((window) => window.id === viewing)
  const selectedWindows = connectionWindows.filter((window) => selectedIds.has(window.id))
  const selectionBusy = selectedWindows.some(isWindowBusy)
  const selectableIds = pageWindows
    .filter((window) => !isWindowBusy(window))
    .map((window) => window.id)
  const selectedPageCount = selectableIds.filter((id) => selectedIds.has(id)).length
  const target = connectionWindows.find((window) => window.id === deleting)
  const running = connectionWindows.filter((window) => window.state === 'running').length
  const proxied = connectionWindows.filter((window) => hasProxy(window)).length
  const bound = accountsInstalled
    ? connectionWindows.filter((window) => bindingOf(window.id) !== null).length
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
            variant="outline"
            disabled={
              !native || !connection?.scopeConfirmed || !connection.capabilities.create
            }
            onClick={() => setBatchCreating(true)}
          >
            <PanelsTopLeft data-icon="inline-start" />
            批量创建
          </Button>
          {connection?.capabilities.attach ? (
            <Button
              variant="outline"
              disabled={!native || !connection.scopeConfirmed}
              onClick={() => setAttaching(true)}
            >
              接入已有窗口
            </Button>
          ) : null}
          <Button
            disabled={
              !native || !connection?.scopeConfirmed || !connection.capabilities.create
            }
            onClick={() => {
              setError(null)
              createIntent.current = null
              setEditing('new')
            }}
          >
            <Plus data-icon="inline-start" />
            创建窗口
          </Button>
        </div>
      </div>
      <Tabs value={providerId} onValueChange={changeProvider}>
        <TabsList aria-label="浏览器提供方">
          {BROWSER_PROVIDERS.map((provider) => (
            <TabsTrigger key={provider.id} value={provider.id}>
              {provider.name}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {native ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            {connection ? `当前接入：${connection.name}` : '此浏览器尚未启用接入'}
          </span>
          <Button size="sm" variant="link" onClick={() => setManagingConnections(true)}>
            配置浏览器接入
          </Button>
        </div>
      ) : null}
      {!native ? (
        <p className="browser-windows-hint" role="status">
          请在 Nexus 桌面应用中创建和打开窗口；网页预览无法访问本机浏览器。
        </p>
      ) : null}
      <div className="window-notices">
        {error ? <FieldError role="alert">{error}</FieldError> : null}
        <Sim8ExpiryNotice
          refreshKey={expiryRefreshKey}
          now={now}
          accounts={accountsReady ? accounts : null}
          bindings={accountsReady ? bindings : []}
          windows={windows}
        />
        {native && connectionId ? (
          <BrowserOperationRecovery
            key={connectionId}
            connectionId={connectionId}
            providerId={providerId}
            refreshKey={expiryRefreshKey}
            onRecovered={(window) => {
              if (window)
                applyWindows((current) =>
                  orderBrowserWindows([
                    window,
                    ...current.filter((item) => item.id !== window.id),
                  ]),
                )
              void load().catch((cause: unknown) => setError(message(cause)))
            }}
          />
        ) : null}
        <TransferRecoveryNotice
          status={recovery.status}
          error={recovery.error}
          checking={recovery.checking}
          onRetry={recovery.retry}
        />
      </div>

      {native ? (
        <div className="space-stats" aria-label="窗口概览">
          <div className="space-stat">
            <span>窗口</span>
            <strong>{connectionWindows.length}</strong>
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
              <strong>{accountsReady ? bound : '—'}</strong>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="window-list-toolbar">
        <div className="window-list-filters" role="group" aria-label="筛选窗口">
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
            <>
              <Select value={groupFilter} onValueChange={setGroupFilter}>
                <SelectTrigger aria-label="筛选分组" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">全部分组</SelectItem>
                    <SelectItem value="ungrouped">未分组</SelectItem>
                    {groups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Select
                value={accountsReady ? accountFilter : 'all'}
                onValueChange={setAccountFilter}
                disabled={!accountsReady}
              >
                <SelectTrigger
                  aria-label="筛选账号状态"
                  className="w-36"
                  title={
                    accountsReady
                      ? undefined
                      : accountsRunning
                        ? '账号资料暂不可用，请刷新后筛选'
                        : '账号插件不可用，暂不筛选账号状态'
                  }
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">全部账号状态</SelectItem>
                    {ACCOUNT_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {STATUS_LABELS[status]}
                      </SelectItem>
                    ))}
                    <SelectItem value="unbound">未关联账号</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </>
          ) : null}
          <span className="result-count">{visible.length} 个窗口</span>
        </div>
        <div className="window-list-actions" role="group" aria-label="窗口批量操作">
          <span className="result-count" aria-live="polite">
            已选 {selectedWindows.length}
          </span>
          {selectedWindows.length ? (
            <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
              清除选择
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={
              !native ||
              !connectionId ||
              selectedWindows.length === 0 ||
              selectionBusy ||
              groupMovePending
            }
            onClick={() => {
              if (
                !connectionId ||
                selectedWindows.length === 0 ||
                selectionBusy ||
                groupMoveRequest.current
              )
                return
              setGroupMoveError(null)
              setGroupMove({
                connectionId,
                ids: selectedWindows.map((window) => window.id),
                epoch: viewEpoch.current,
                destination: 'ungrouped',
              })
            }}
          >
            <FolderInput data-icon="inline-start" />
            移动分组
          </Button>
          <TransferToolbar
            key={`${filterKey}:${connection?.revision ?? 0}`}
            native={native}
            connection={connection}
            windows={selectedWindows}
            operating={operatingWindows}
            onImported={refreshAfterImport}
          />
        </div>
      </div>

      <div className="space-table-panel">
        <div className="panel-heading">
          <h2>全部窗口</h2>
          <Badge variant="secondary">{connectionWindows.length}</Badge>
        </div>
        <Table aria-label="窗口列表">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label="全选本页窗口"
                  disabled={!native || selectableIds.length === 0}
                  checked={
                    selectedPageCount === 0
                      ? false
                      : selectedPageCount === selectableIds.length
                        ? true
                        : 'indeterminate'
                  }
                  onCheckedChange={(checked) =>
                    selectionScope.current === connectionId &&
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
            {pageWindows.map((window) => {
              const account = bindingOf(window.id)
              const linked =
                account === null
                  ? null
                  : (accounts.find((item) => item.id === account.accountId) ?? null)
              const summary = accountSummaryOf(account)
              const accountNameClass =
                summary?.status === 'blocked' ? 'text-destructive' : undefined
              const phoneUnlinkPending = linked !== null && unlinkingPhones.has(linked.id)
              const starting =
                window.state === 'starting' ||
                (window.state !== 'running' && startingWindows.has(window.id))
              const checkingProxy =
                gate?.window.id === window.id && gate.stage.stage === 'checking'
              const busy = isWindowBusy(window)
              const unconfirmed =
                unconfirmedWindows.has(window.id) ||
                window.state === 'unknown' ||
                window.state === 'missing'
              return (
                <TableRow
                  key={window.id}
                  className={starting ? 'space-row-starting' : undefined}
                  aria-busy={starting || undefined}
                  data-running={window.state === 'running' ? 'true' : undefined}
                  data-state={selectedIds.has(window.id) ? 'selected' : undefined}
                >
                  <TableCell>
                    <Checkbox
                      aria-label={`选择窗口 ${window.name}`}
                      checked={selectedIds.has(window.id)}
                      disabled={!native || busy}
                      onCheckedChange={(checked) =>
                        selectionScope.current === window.connectionId &&
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
                        data-tone={window.state === 'running' ? 'blue' : undefined}
                        aria-hidden="true"
                      >
                        {window.name.slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <strong>{window.name}</strong>
                        <WindowNote
                          id={window.id}
                          name={window.name}
                          note={window.settings.note}
                          onSaved={(note) =>
                            applyWindows((current) =>
                              current.map((item) =>
                                item.id === window.id
                                  ? { ...item, settings: { ...item.settings, note } }
                                  : item,
                              ),
                            )
                          }
                        />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{window.settings.platform}</Badge>
                  </TableCell>
                  {accountsInstalled ? (
                    <TableCell>
                      {!accountsReady ? (
                        <span className="table-muted">账号资料暂不可用</span>
                      ) : account === null ? (
                        <AccountQuickAdd
                          window={window}
                          ready={accountsReady}
                          accounts={accounts}
                          onSaved={refreshAfterBinding}
                        />
                      ) : (
                        <span className="account-cell-row">
                          <span className="account-cell">
                            {linked === null ? (
                              <strong className={accountNameClass}>
                                {summary?.account ?? '账号已删除'}
                              </strong>
                            ) : (
                              <Button
                                type="button"
                                variant="link"
                                size="xs"
                                className="h-auto max-w-full justify-start p-0 text-left"
                                aria-label={`编辑 ${linked.account} 的账号资料`}
                                title="编辑账号资料"
                                disabled={!accountsReady || phoneUnlinkPending}
                                onClick={() => setEditingAccount(linked)}
                              >
                                <strong className={accountNameClass}>
                                  {linked.account}
                                </strong>
                                <Pencil data-icon="inline-end" />
                              </Button>
                            )}
                            <span className="account-cell-meta">
                              {summary === null ? null : (
                                <Badge variant={statusVariant(summary.status)}>
                                  {STATUS_LABELS[summary.status]}
                                </Badge>
                              )}
                              {linked === null ? null : (
                                <AccountPhoneCopy account={linked} />
                              )}
                              {linked === null ? null : (
                                <AccountSmsWaitButton
                                  account={linked}
                                  windowId={window.id}
                                  windowName={window.name}
                                  ready={accountsReady && !phoneUnlinkPending}
                                />
                              )}
                              {linked === null || linked.phone.trim() === '' ? null : (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  className="size-[22px]"
                                  aria-label={`解绑 ${linked.account} 的手机号`}
                                  aria-busy={phoneUnlinkPending}
                                  title="清空此账号的手机号和短信接码链接，同步所有关联窗口；保留 SIM8 号码池"
                                  disabled={!accountsReady || phoneUnlinkPending}
                                  onClick={() => void unlinkPhone(linked.id)}
                                >
                                  {phoneUnlinkPending ? (
                                    <Loader2
                                      className="animate-spin"
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <Unlink aria-hidden="true" />
                                  )}
                                </Button>
                              )}
                            </span>
                          </span>
                          {linked === null ? null : (
                            <AccountSmsPopover
                              key={linked.id}
                              account={linked}
                              ready={accountsReady && !phoneUnlinkPending}
                              onSaved={applySavedAccount}
                            />
                          )}
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
                      className="status-badge min-w-24 justify-center"
                      data-state={
                        unconfirmed || starting
                          ? 'pending'
                          : window.state === 'running'
                            ? 'running'
                            : 'stopped'
                      }
                    >
                      <span className="status-dot" aria-hidden="true" />
                      {unconfirmed
                        ? window.state === 'missing'
                          ? '环境不可见'
                          : '状态待确认'
                        : checkingProxy
                          ? '检测代理中'
                          : starting
                            ? '启动中'
                            : busy
                              ? '操作中'
                              : window.state === 'running'
                                ? '运行中'
                                : window.state === 'missing'
                                  ? '环境不可见'
                                  : window.state === 'unknown'
                                    ? '状态待确认'
                                    : '已停止'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="table-actions">
                      <Button
                        variant={window.state === 'running' ? 'outline' : 'default'}
                        size="sm"
                        className="w-28"
                        disabled={busy && !unconfirmed}
                        onClick={() =>
                          void (unconfirmed
                            ? refreshGate(window)
                            : window.state === 'running'
                              ? stop(window)
                              : open(window))
                        }
                      >
                        {unconfirmed ? (
                          <RefreshCw data-icon="inline-start" />
                        ) : busy ? (
                          <Loader2 data-icon="inline-start" className="animate-spin" />
                        ) : window.state === 'running' ? (
                          <Square data-icon="inline-start" />
                        ) : (
                          <Play data-icon="inline-start" />
                        )}
                        {unconfirmed
                          ? '确认状态'
                          : checkingProxy
                            ? '正在检测…'
                            : busy
                              ? startingWindows.has(window.id)
                                ? '正在打开…'
                                : '正在停止…'
                              : window.state === 'running'
                                ? '停止'
                                : '打开'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`编辑 ${window.name}`}
                        disabled={busy}
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
                        aria-label={`查看 ${window.name} 的执行记录`}
                        title="执行记录"
                        onClick={() =>
                          navigateDetail({
                            kind: 'agent',
                            id: window.id,
                            related: 'window',
                          })
                        }
                      >
                        <ClipboardList />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${window.providerId !== 'cloakbrowser' && window.origin === 'attached' ? '移出 Nexus' : '删除'} ${window.name}`}
                        disabled={
                          busy ||
                          (window.providerId !== 'cloakbrowser' &&
                          window.origin === 'attached'
                            ? unconfirmed
                            : window.state !== 'stopped') ||
                          (window.origin === 'created' &&
                            !connection?.capabilities.deleteEnvironment)
                        }
                        onClick={() => {
                          setDeleteEnvironment(
                            window.providerId === 'cloakbrowser' ||
                              window.origin === 'created',
                          )
                          setDeleting(window.id)
                        }}
                      >
                        <Trash2 />
                      </Button>
                      {window.providerId !== 'cloakbrowser' ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`环境操作 ${window.name}`}
                            >
                              <Ellipsis />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              disabled={busy || unconfirmed}
                              onSelect={() => {
                                setDeleteEnvironment(false)
                                setDeleting(window.id)
                              }}
                            >
                              移出 Nexus
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={
                                busy ||
                                window.state !== 'stopped' ||
                                !connection?.capabilities.deleteEnvironment
                              }
                              onSelect={() => {
                                setDeleteEnvironment(true)
                                setDeleting(window.id)
                              }}
                            >
                              删除浏览器环境
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                      {accountsInstalled ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`更多操作 ${window.name}`}
                              disabled={!accountsReady}
                            >
                              <Ellipsis />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Vinted 账号</DropdownMenuLabel>
                            {linked === null ? null : (
                              <DropdownMenuItem
                                disabled={!accountsReady || phoneUnlinkPending}
                                onSelect={() => setEditingAccount(linked)}
                              >
                                <Pencil />
                                编辑账号资料
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              disabled={!accountsReady || bindingPending}
                              onSelect={() => {
                                if (!accountsReady || !accountSync.current.ready) return
                                dismissBinding()
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
                                  disabled={!accountsReady || bindingPending}
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
              <EmptyTitle>
                {connectionWindows.length
                  ? '没有找到窗口'
                  : connection
                    ? '还没有窗口'
                    : '尚未启用浏览器接入'}
              </EmptyTitle>
              <EmptyDescription>
                {connectionWindows.length
                  ? '调整搜索条件。'
                  : connection
                    ? '创建窗口或选择官方已有环境接入。'
                    : '请在浏览器接入设置中保存、检测并确认账户作用域，再启用接入。'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        <nav className="window-pagination" aria-label="窗口列表分页">
          <span className="result-count" role="status" aria-live="polite">
            共 {visible.length} 个窗口
            {visible.length > 0
              ? ` · 第 ${pageOffset + 1}–${pageOffset + pageWindows.length} 条`
              : null}
          </span>
          <div className="window-pagination-controls">
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                const size = WINDOW_PAGE_SIZES.find((entry) => String(entry) === value)
                if (size === undefined) return
                setPageSize(size)
                setPage(1)
              }}
            >
              <SelectTrigger aria-label="每页窗口数" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {WINDOW_PAGE_SIZES.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      每页 {size}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <span className="result-count">
              第 {currentPage} / {pageCount} 页
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="首页"
              title="首页"
              disabled={currentPage === 1}
              onClick={() => setPage(1)}
            >
              <ChevronsLeft aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="上一页"
              title="上一页"
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="下一页"
              title="下一页"
              disabled={currentPage === pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="末页"
              title="末页"
              disabled={currentPage === pageCount}
              onClick={() => setPage(pageCount)}
            >
              <ChevronsRight aria-hidden="true" />
            </Button>
          </div>
        </nav>
      </div>

      <Dialog
        open={groupMove !== null}
        onOpenChange={(open) => {
          if (!open && !groupMoveRequest.current) setGroupMove(null)
        }}
      >
        {groupMove ? (
          <DialogContent
            className="sm:max-w-sm"
            showCloseButton={!groupMovePending}
            onEscapeKeyDown={(event) => {
              if (groupMoveRequest.current) event.preventDefault()
            }}
            onInteractOutside={(event) => {
              if (groupMoveRequest.current) event.preventDefault()
            }}
          >
            <DialogHeader>
              <DialogTitle>移动分组</DialogTitle>
              <DialogDescription>
                将已选的 {groupMove.ids.length} 个窗口移动到所选分组。
              </DialogDescription>
            </DialogHeader>
            <form
              className="grid gap-4"
              aria-label="批量移动分组"
              onSubmit={moveSelectedGroup}
            >
              <Field>
                <FieldLabel htmlFor="window-move-group">目标分组</FieldLabel>
                <Select
                  value={groupMove.destination}
                  disabled={groupMovePending}
                  onValueChange={(destination) => {
                    if (!groupMoveRequest.current)
                      setGroupMove((current) =>
                        current ? { ...current, destination } : current,
                      )
                  }}
                >
                  <SelectTrigger id="window-move-group" aria-label="目标分组">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="ungrouped">未分组</SelectItem>
                      {groups.map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {group.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {groupMoveError ? (
                  <FieldError role="alert">{groupMoveError}</FieldError>
                ) : null}
              </Field>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={groupMovePending}
                  onClick={() => {
                    if (!groupMoveRequest.current) setGroupMove(null)
                  }}
                >
                  取消
                </Button>
                <Button type="submit" disabled={groupMovePending}>
                  {groupMovePending ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : null}
                  {groupMovePending ? '移动中…' : '确认移动'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>

      {batchCreating && connection ? (
        <BatchWindowDialog
          connection={connection}
          onClose={() => setBatchCreating(false)}
          onSettled={async (items) => {
            applyWindows((current) => mergeBatchWindows(current, items))
            if (
              selectionScope.current === connection.id &&
              items.some((item) => item.window !== null)
            )
              setPage(1)
            await load()
          }}
        />
      ) : null}

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        {editing !== null && connection ? (
          <WindowEditor
            connection={connection}
            key={editing}
            window={
              editing === 'new'
                ? null
                : (windows.find((item) => item.id === editing) ?? null)
            }
            groups={groups}
            takenNames={windows.map((item) => item.name)}
            onSave={async (input) => {
              const epoch = viewEpoch.current
              const id = editing
              if (id === 'new') {
                if (!('kernelVersion' in input)) throw new Error('创建请求缺少内核选择。')
                const previous = createIntent.current
                if (
                  previous &&
                  JSON.stringify({
                    ...input,
                    connectionId: connection.id,
                    operationId: previous.operationId,
                  }) !== JSON.stringify(previous)
                )
                  throw new Error(
                    '上次创建结果尚待核对，请先恢复该操作，再开始不同的创建请求。',
                  )
                const intent = previous ?? {
                  ...input,
                  connectionId: connection.id,
                  operationId: crypto.randomUUID(),
                }
                createIntent.current = intent
                let saved: BrowserWindow
                try {
                  saved = await createBrowserWindow(intent)
                } catch (cause) {
                  setExpiryRefreshKey((value) => value + 1)
                  throw cause
                }
                applyWindows((current) =>
                  orderBrowserWindows([
                    saved,
                    ...current.filter((window) => window.id !== saved.id),
                  ]),
                )
                if (epoch === viewEpoch.current) setPage(1)
              } else {
                if ('kernelVersion' in input)
                  throw new Error('窗口编辑不能修改既有内核绑定。')
                await updateBrowserWindow({ id, ...input })
                await load()
              }
              if (epoch === viewEpoch.current) setEditing(null)
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
                  <dd>
                    {!accountsReady
                      ? '账号资料暂不可用'
                      : bindingOf(selected.id) === null
                        ? '未关联'
                        : (accountSummaryOf(bindingOf(selected.id))?.account ??
                          '账号已删除')}
                  </dd>
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
                  {selected.proxyMode === 'provider'
                    ? '沿用浏览器设置'
                    : selected.proxyPlugin
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
              <AlertDialogTitle>
                {deleteEnvironment ? '删除浏览器环境' : '移出 Nexus'}「{target.name}」？
              </AlertDialogTitle>
              <AlertDialogDescription>
                {deleteEnvironment
                  ? '将永久删除该浏览器环境及其 Cookie 和登录状态，并清理 Nexus 关联，无法撤销。'
                  : '仅解除 Nexus 的窗口与插件关联。官方浏览器环境保留，也不会自动关闭。'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={deletePending}
                onClick={(event) => {
                  event.preventDefault()
                  if (
                    deletingRequest.current ||
                    (deleteEnvironment && target.state !== 'stopped')
                  )
                    return
                  deletingRequest.current = true
                  setDeletePending(true)
                  const epoch = viewEpoch.current
                  void deleteBrowserWindow(target.id, deleteEnvironment)
                    .then(async () => {
                      smsWaits.stopWindow(target.id)
                      applyWindows((current) =>
                        current.filter((window) => window.id !== target.id),
                      )
                      await load()
                      if (epoch === viewEpoch.current) setDeleting(null)
                    })
                    .catch((cause: unknown) => {
                      if (epoch === viewEpoch.current) setError(message(cause))
                    })
                    .finally(() => {
                      deletingRequest.current = false
                      setDeletePending(false)
                    })
                }}
              >
                {deleteEnvironment ? '删除浏览器环境' : '移出 Nexus'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>

      <Dialog open={attaching} onOpenChange={setAttaching}>
        {attaching && connection ? (
          <AttachWindowDialog
            key={`${connection.id}:${connection.revision}`}
            connection={connection}
            onClose={() => setAttaching(false)}
            onAttached={(attached) => {
              applyWindows((current) =>
                orderBrowserWindows([
                  ...current.filter(
                    (window) => !attached.some((row) => row.id === window.id),
                  ),
                  ...attached,
                ]),
              )
              if (selectionScope.current === connection.id && attached.length > 0)
                setPage(1)
              void load().catch((cause: unknown) => setError(message(cause)))
            }}
          />
        ) : null}
      </Dialog>
      <Dialog
        open={managingConnections}
        onOpenChange={(next) => {
          setManagingConnections(next)
          if (!next)
            void loadConnections().catch((cause: unknown) => setError(message(cause)))
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>浏览器接入设置</DialogTitle>
            <DialogDescription>保存并启用接入后返回窗口管理。</DialogDescription>
          </DialogHeader>
          <BrowserConnectionsPage />
        </DialogContent>
      </Dialog>
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
        open={editingAccount !== null}
        onOpenChange={(open) => {
          if (!open) setEditingAccount(null)
        }}
      >
        {editingAccount === null ? null : (
          <AccountEditor
            key={editingAccount.id}
            account={editingAccount}
            ready={accountsReady}
            description={`修改会同步到关联此账号的 ${bindings.filter((item) => item.accountId === editingAccount.id).length} 个窗口，不改变关联关系。`}
            onSave={async (input) => {
              if (!accountsReady || !accountSync.current.ready) {
                throw new Error('账号资料暂不可用，请刷新后重试。')
              }
              const { item } = await saveAccount(input)
              applySavedAccount(item)
              toast.success('账号已保存')
              setEditingAccount(null)
            }}
            onCancel={() => setEditingAccount(null)}
          />
        )}
      </Dialog>

      <Dialog
        open={binding !== null}
        onOpenChange={(open) => {
          if (!open) dismissBinding()
        }}
      >
        {binding === null ? null : (
          <AccountBindDialog
            key={binding.id}
            window={binding}
            ready={accountsReady}
            accounts={accountsReady ? accounts : []}
            current={bindingOf(binding.id)?.accountId ?? null}
            pending={bindingPending}
            error={bindingError}
            onConfirm={(accountId) => void bind(binding, accountId)}
            onCancel={dismissBinding}
          />
        )}
      </Dialog>

      <AlertDialog
        open={conflict !== null}
        onOpenChange={(open) => {
          if (!open) {
            bindingSession.current += 1
            setConflict(null)
            setBindingError(null)
            setBindingPending(false)
          }
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
                disabled={!accountsReady || bindingPending}
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

function ProxyCell({ window }: { window: BrowserWindow }) {
  if (window.proxyMode === 'provider')
    return <span className="table-muted">沿用浏览器设置</span>
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
 * Keep choosing an account and creating one in separate, compact views.
 */
function AccountQuickAdd({
  window,
  ready,
  accounts,
  onSaved,
}: {
  window: BrowserWindow
  ready: boolean
  accounts: Account[]
  onSaved: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('existing')
  const [query, setQuery] = useState('')
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const visible = accounts.filter((item) =>
    `${item.account} ${item.note} ${item.phone}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  )

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
        if (pending || (next && !ready)) return
        if (next) {
          setTab(
            accounts.length === 0 || account !== '' || password !== '' || note !== ''
              ? 'create'
              : 'existing',
          )
        }
        setOpen(next)
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
      <PopoverContent align="start" className="account-quick-add account-compact-popover">
        <PopoverHeader>
          <PopoverTitle>关联 Vinted 账号</PopoverTitle>
        </PopoverHeader>
        <Tabs value={tab} onValueChange={setTab} className="account-popover-tabs">
          <TabsList aria-label="关联账号方式">
            <TabsTrigger value="existing" disabled={pending || !ready}>
              选择已有
            </TabsTrigger>
            <TabsTrigger value="create" disabled={pending || !ready}>
              新建账号
            </TabsTrigger>
          </TabsList>
          <TabsContent value="existing">
            {accounts.length === 0 ? (
              <p className="account-quick-note">账号池为空，请切换到「新建账号」。</p>
            ) : (
              <div className="account-quick-pool">
                <div className="search-field">
                  <Search aria-hidden="true" />
                  <Input
                    aria-label="搜索账号池"
                    placeholder="搜索账号，点选关联"
                    disabled={pending || !ready}
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
                      disabled={pending || !ready}
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
          </TabsContent>
          <TabsContent value="create">
            <form className="account-quick-form" onSubmit={(event) => void submit(event)}>
              <Field>
                <FieldLabel htmlFor={`quick-account-${window.id}`}>账号</FieldLabel>
                <Input
                  id={`quick-account-${window.id}`}
                  autoComplete="off"
                  placeholder="登录邮箱或用户名"
                  maxLength={190}
                  disabled={pending || !ready}
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
                  maxLength={190}
                  disabled={pending || !ready}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`quick-note-${window.id}`}>备注</FieldLabel>
                <Input
                  id={`quick-note-${window.id}`}
                  placeholder="可选"
                  maxLength={200}
                  disabled={pending || !ready}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </Field>
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
                <Button type="submit" size="sm" disabled={pending || !ready}>
                  {pending ? '保存中…' : '保存并关联'}
                </Button>
              </div>
            </form>
          </TabsContent>
        </Tabs>
        {error === null ? null : <FieldError role="alert">{error}</FieldError>}
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
  window: BrowserWindow
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
            disabled={pending || !ready}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {!ready ? (
          <p className="text-sm text-muted-foreground">
            账号资料暂不可用，请刷新后重试。
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
                disabled={pending || !ready}
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
          disabled={!ready || pending || selected === null}
          onClick={() => {
            if (ready && !pending && selected !== null) onConfirm(selected)
          }}
        >
          {pending ? '正在关联…' : '关联'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
