import { useEffect, useState, type ReactNode } from 'react'
import {
  History,
  Loader2,
  MoreHorizontal,
  Package,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { FieldError } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from '@/components/ui/toast'
import { listMonitors, listProxies, removeMonitor, runMonitor } from './api'
import { safeExternalUrl } from './item-filters'
import { MonitorFormSheet } from './monitor-form-sheet'
import { RunsSheet } from './runs-sheet'
import { ColumnMenu, TablePager } from './table-controls'
import {
  formatTime,
  kindText,
  message,
  runStatusText,
  type Monitor,
  type MonitorList,
  type ProxyList,
} from './types'

const COLUMNS = [
  { id: 'name', label: '名称' },
  { id: 'kind', label: '监控类型' },
  { id: 'url', label: '监控 URL' },
  { id: 'proxy', label: '代理' },
  { id: 'interval', label: '间隔（分钟）' },
  { id: 'pages', label: '最多页数' },
  { id: 'size', label: '每页商品数' },
  { id: 'enabled', label: '状态' },
  { id: 'created', label: '创建时间' },
  { id: 'run', label: '最近采集' },
  { id: 'count', label: '商品数' },
]

export function MonitorListView({
  refreshKey,
  modern,
  onItems,
  onConfigureProxies,
}: {
  refreshKey: number
  modern: boolean
  onItems: (monitorId: string) => void
  onConfigureProxies: () => void
}) {
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(20)
  const [nonce, setNonce] = useState(0)
  const [hidden, setHidden] = useState<string[]>([])
  const [state, setState] = useState<{
    key: string
    data: MonitorList | null
    error: string | null
  } | null>(null)
  const [proxies, setProxies] = useState<ProxyList | null>(null)
  const [proxyError, setProxyError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ monitor: Monitor | null } | null>(null)
  const [history, setHistory] = useState<Monitor | null>(null)
  const [removing, setRemoving] = useState<Monitor | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const key = `${page}:${pageSize}`
  const current = state?.key === key ? state : null
  const rows = current?.data?.items ?? []
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function read() {
      try {
        const data = await listMonitors({ page, pageSize })
        if (!active) return
        const last = Math.max(0, Math.ceil(data.total / pageSize) - 1)
        if (page > last) {
          setPage(last)
          return
        }
        setState({ key, data, error: null })
      } catch (cause) {
        if (active) setState({ key, data: null, error: message(cause) })
      } finally {
        if (active) timer = setTimeout(() => void read(), 5000)
      }
    }
    void read()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [key, page, pageSize, nonce, refreshKey])
  useEffect(() => {
    if (!modern) return
    let active = true
    void listProxies().then(
      (data) => {
        if (active) {
          setProxies(data)
          setProxyError(null)
        }
      },
      (cause: unknown) => {
        if (active) setProxyError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [modern, refreshKey, nonce])
  function proxyName(monitor: Monitor): string {
    const id = monitor.proxyId ?? proxies?.defaultProxyId
    if (!modern) return '应用代理'
    if (proxyError) return '代理读取失败'
    if (!proxies) return '读取中'
    if (!id) return '跟随应用代理'
    const proxy = proxies.items.find((entry) => entry.id === id)
    return proxy
      ? `${proxy.name}${proxy.enabled ? '' : '（已停用）'}${monitor.proxyId ? '' : '（默认）'}`
      : '代理已删除'
  }
  async function collect(monitor: Monitor) {
    if (busy || !monitor.enabled) return
    setBusy(monitor.id)
    try {
      await runMonitor(monitor.id)
      toast.success(`「${monitor.name}」已开始采集`)
      setNonce((value) => value + 1)
      setHistory(monitor)
    } catch (cause) {
      toast.error(message(cause))
    } finally {
      setBusy(null)
    }
  }
  async function drop() {
    if (!removing || busy) return
    setBusy(removing.id)
    setRemoveError(null)
    try {
      await removeMonitor(removing.id)
      setRemoving(null)
      setNonce((value) => value + 1)
      toast.success('监控已删除')
    } catch (cause) {
      setRemoveError(message(cause))
    } finally {
      setBusy(null)
    }
  }
  const visible = COLUMNS.filter((column) => !hidden.includes(column.id))
  return (
    <div className="vinted-body">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {current?.data ? `共 ${current.data.total} 个监控` : 'URL 监控'}
          {current?.data?.storageDurable === false ? ' · 仅本次运行' : ''}
        </span>
        <div className="flex flex-wrap gap-2">
          <ColumnMenu columns={COLUMNS} hidden={hidden} onChange={setHidden} />
          <Button
            size="sm"
            variant="outline"
            onClick={() => setNonce((value) => value + 1)}
          >
            <RefreshCw data-icon="inline-start" />
            刷新监控
          </Button>
          <Button size="sm" onClick={() => setEditing({ monitor: null })}>
            <Plus data-icon="inline-start" />
            新增监控
          </Button>
        </div>
      </div>
      {proxyError ? (
        <FieldError role="alert">
          代理列表加载失败：{proxyError}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setNonce((value) => value + 1)}
          >
            重试
          </Button>
        </FieldError>
      ) : null}
      {current === null ? (
        <div className="vinted-skeleton">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : current.error ? (
        <FieldError role="alert">
          {current.error}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setNonce((value) => value + 1)}
          >
            重新加载
          </Button>
        </FieldError>
      ) : rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>还没有监控</EmptyTitle>
            <EmptyDescription>新增 Vinted 目录筛选或用户衣柜 URL。</EmptyDescription>
          </EmptyHeader>
          <Button size="sm" onClick={() => setEditing({ monitor: null })}>
            新增监控
          </Button>
        </Empty>
      ) : (
        <div className="vinted-table-scroll">
          <Table>
            <TableHeader>
              <TableRow>
                {visible.map((column) => (
                  <TableHead key={column.id}>{column.label}</TableHead>
                ))}
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((monitor) => {
                const url = safeExternalUrl(monitor.searchUrl)
                const cells: Record<string, ReactNode> = {
                  name: (
                    <button
                      className="vinted-text-link"
                      onClick={() => setHistory(monitor)}
                    >
                      {monitor.name}
                    </button>
                  ),
                  kind: (
                    <Badge variant={monitor.kind === 'member' ? 'secondary' : 'outline'}>
                      {kindText(monitor.kind)}
                    </Badge>
                  ),
                  url: url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="vinted-url"
                      title={monitor.searchUrl}
                    >
                      {monitor.searchUrl}
                    </a>
                  ) : (
                    monitor.searchUrl
                  ),
                  proxy: proxyName(monitor),
                  interval: monitor.intervalMinutes,
                  pages: monitor.maxPages,
                  size: monitor.perPage,
                  enabled: (
                    <Badge variant={monitor.enabled ? 'secondary' : 'outline'}>
                      {monitor.enabled ? '已启用' : '已停用'}
                    </Badge>
                  ),
                  created: formatTime(monitor.createdAt),
                  run: (
                    <Badge
                      variant={
                        monitor.lastStatus === 'failed' ? 'destructive' : 'outline'
                      }
                    >
                      {monitor.lastStatus ? runStatusText(monitor.lastStatus) : '未采集'}
                    </Badge>
                  ),
                  count: (
                    <button
                      className="vinted-text-link"
                      disabled={!modern}
                      onClick={() => onItems(monitor.id)}
                    >
                      {current.data?.itemCounts[monitor.id] ?? 0}
                    </button>
                  ),
                }
                return (
                  <TableRow key={monitor.id}>
                    {visible.map((column) => (
                      <TableCell key={column.id}>{cells[column.id]}</TableCell>
                    ))}
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`操作 ${monitor.name}`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              disabled={
                                !!busy ||
                                !monitor.enabled ||
                                monitor.lastStatus === 'running'
                              }
                              onClick={() => void collect(monitor)}
                            >
                              <Play />
                              {monitor.enabled ? '立即采集' : '立即采集（请先启用）'}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setHistory(monitor)}>
                              <History />
                              采集记录
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!modern}
                              onClick={() => onItems(monitor.id)}
                            >
                              <Package />
                              查看商品
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setEditing({ monitor })}>
                              <Pencil />
                              编辑监控
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={monitor.lastStatus === 'running'}
                              onClick={() => {
                                setRemoveError(null)
                                setRemoving(monitor)
                              }}
                            >
                              <Trash2 />
                              删除监控
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {current?.data ? (
        <TablePager
          {...{ page, pageSize }}
          total={current.data.total}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size)
            setPage(0)
          }}
        />
      ) : null}
      {editing ? (
        <MonitorFormSheet
          key={editing.monitor?.id ?? 'new'}
          monitor={editing.monitor}
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          onSaved={() => setNonce((value) => value + 1)}
          onConfigureProxies={onConfigureProxies}
        />
      ) : null}
      {history ? (
        <RunsSheet
          monitor={history}
          onOpenChange={(open) => {
            if (!open) setHistory(null)
          }}
        />
      ) : null}
      <AlertDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除监控</AlertDialogTitle>
            <AlertDialogDescription>
              删除「{removing?.name}」将停止定时采集。已采集商品保留在商品表格中。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError ? <FieldError role="alert">{removeError}</FieldError> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!busy}
              onClick={(event) => {
                event.preventDefault()
                void drop()
              }}
            >
              {busy ? <Loader2 className="animate-spin" /> : null}删除监控
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
