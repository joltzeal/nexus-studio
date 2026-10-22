import { useCallback, useEffect, useState } from 'react'
import {
  History,
  Loader2,
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
import { Card } from '@/components/ui/card'
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
import {
  enablePlugin,
  listPlugins,
  pluginHostAvailable,
  restartPlugin,
  type PluginView,
} from '@/lib/platform/native-plugins'
import { listMonitors, removeMonitor, runMonitor } from './api'
import { ItemsSheet } from './items-sheet'
import { MonitorFormSheet } from './monitor-form-sheet'
import { RunsSheet } from './runs-sheet'
import {
  VINTED_CAPABILITY,
  VINTED_PLUGIN_ID,
  formatTime,
  intervalText,
  kindText,
  message,
  runStatusText,
  type Monitor,
  type RunStatus,
} from './types'

const POLL_MS = 4000

function statusBadge(status: RunStatus | null): 'secondary' | 'destructive' | 'outline' {
  if (status === 'success') return 'secondary'
  if (status === 'failed') return 'destructive'
  return 'outline'
}

export interface VintedMonitorPageProps {
  plugin: PluginView | null
  hostAvailable: boolean
  onEnable?: () => Promise<void>
}

export function VintedMonitorPage({
  plugin,
  hostAvailable,
  onEnable,
}: VintedMonitorPageProps) {
  const running = plugin !== null && plugin.state === 'running'
  const [monitors, setMonitors] = useState<Monitor[] | null>(null)
  const [itemCounts, setItemCounts] = useState<Record<string, number>>({})
  const [storageDurable, setStorageDurable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [editing, setEditing] = useState<{ monitor: Monitor | null } | null>(null)
  const [runsFor, setRunsFor] = useState<Monitor | null>(null)
  const [itemsFor, setItemsFor] = useState<Monitor | null>(null)
  const [removing, setRemoving] = useState<Monitor | null>(null)
  const [starting, setStarting] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const result = await listMonitors()
      setMonitors(result.items)
      setItemCounts(result.itemCounts)
      setStorageDurable(result.storageDurable)
      setError(null)
    } catch (cause) {
      setMonitors([])
      setItemCounts({})
      setError(message(cause))
    }
  }, [])

  useEffect(() => {
    if (!running) return
    let active = true
    void listMonitors().then(
      (result) => {
        if (!active) return
        setMonitors(result.items)
        setItemCounts(result.itemCounts)
        setStorageDurable(result.storageDurable)
        setError(null)
      },
      (cause: unknown) => {
        if (!active) return
        setMonitors([])
        setItemCounts({})
        setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [running, nonce])

  const polling = (monitors ?? []).some((monitor) => monitor.lastStatus === 'running')

  // Only poll while a collection is actually in flight.
  useEffect(() => {
    if (!running || !polling) return
    const timer = setInterval(() => {
      setNonce((current) => current + 1)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [running, polling])

  async function collect(monitor: Monitor) {
    setStarting(monitor.id)
    try {
      await runMonitor(monitor.id)
      toast.success('已开始采集，稍后查看记录')
      await refresh()
    } catch (cause) {
      setError(message(cause))
      toast.error(message(cause))
    } finally {
      setStarting(null)
    }
  }

  async function confirmRemove() {
    if (removing === null) return
    const target = removing
    setRemoving(null)
    try {
      await removeMonitor(target.id)
      toast.success('监控已删除')
      await refresh()
    } catch (cause) {
      setError(message(cause))
      toast.error(message(cause))
    }
  }

  const showContent = hostAvailable && plugin !== null && running

  return (
    <section
      className="collection-page page-reveal vinted-viewport"
      aria-labelledby="vinted-heading"
    >
      <Card className="vinted-shell">
        <div className="vinted-shell-head">
          <div>
            <h1 className="page-heading" id="vinted-heading">
              Vinted 监控
            </h1>
            <p className="page-description">
              按搜索页或会员衣柜定时采集商品，每次采集留一条记录，已采集的商品按上架时间归档。
            </p>
          </div>
          <div className="section-actions">
            <Button
              variant="outline"
              size="sm"
              disabled={!showContent}
              onClick={() => void refresh()}
            >
              <RefreshCw data-icon="inline-start" />
              刷新
            </Button>
            <Button
              size="sm"
              disabled={!showContent}
              onClick={() => setEditing({ monitor: null })}
            >
              <Plus data-icon="inline-start" />
              新增监控
            </Button>
          </div>
        </div>

        {showContent && monitors !== null && monitors.length > 0 ? (
          <div className="vinted-toolbar">
            <span className="vinted-muted">
              共 {monitors.length} 个监控
              {Object.values(itemCounts).reduce((total, value) => total + value, 0) > 0
                ? ` · 已归档 ${String(
                    Object.values(itemCounts).reduce((total, value) => total + value, 0),
                  )} 件商品`
                : ''}
            </span>
            <span className="vinted-muted">
              {storageDurable ? '采集数据保存在插件私有目录' : '仅本次运行 · 重启后丢失'}
            </span>
          </div>
        ) : null}

        <div className="vinted-body">
          {!hostAvailable ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Vinted 监控需要桌面应用</EmptyTitle>
                <EmptyDescription>
                  采集由插件进程请求 Vinted 的公开接口，网页预览没有插件宿主。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : plugin === null ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Vinted 监控插件尚未安装</EmptyTitle>
                <EmptyDescription>
                  到插件中心安装并启用「Vinted 商品监控」后，这里可以创建采集任务。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : !running ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {plugin.state === 'failed'
                    ? '插件进程启动失败'
                    : 'Vinted 监控插件未启用'}
                </EmptyTitle>
                <EmptyDescription>
                  {plugin.lastError ??
                    (plugin.enabled
                      ? '插件已授权，但进程没有运行；采集需要进程就绪。'
                      : `到插件中心启用并授予 ${VINTED_CAPABILITY} 能力后，这里可以创建监控。`)}
                </EmptyDescription>
              </EmptyHeader>
              {plugin.enabled && onEnable ? (
                <Button
                  onClick={() => {
                    void onEnable()
                  }}
                >
                  重新启动插件进程
                </Button>
              ) : null}
            </Empty>
          ) : (
            <>
              {error === null ? null : <FieldError role="alert">{error}</FieldError>}
              {monitors === null ? (
                <div className="vinted-skeleton">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : monitors.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>还没有监控</EmptyTitle>
                    <EmptyDescription>
                      粘贴一个 Vinted 搜索页或会员衣柜地址，设好间隔与页数就能开始采集。
                    </EmptyDescription>
                  </EmptyHeader>
                  <Button onClick={() => setEditing({ monitor: null })}>
                    <Plus data-icon="inline-start" />
                    新增监控
                  </Button>
                </Empty>
              ) : (
                <div className="vinted-table-scroll">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>名称</TableHead>
                        <TableHead className="vinted-col-kind">类型</TableHead>
                        <TableHead>监控 URL</TableHead>
                        <TableHead className="vinted-col-small">间隔</TableHead>
                        <TableHead className="vinted-col-small">页数 × 每页</TableHead>
                        <TableHead className="vinted-col-small">已采集</TableHead>
                        <TableHead className="vinted-col-small">最近采集</TableHead>
                        <TableHead className="vinted-col-actions">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {monitors.map((monitor) => (
                        <TableRow key={monitor.id}>
                          <TableCell>
                            <div className="vinted-row-title">
                              <strong>{monitor.name}</strong>
                              {monitor.enabled ? null : (
                                <Badge variant="outline">已暂停</Badge>
                              )}
                            </div>
                            <div className="vinted-muted">
                              创建于 {formatTime(monitor.createdAt)}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{kindText(monitor.kind)}</Badge>
                          </TableCell>
                          <TableCell>
                            <span className="vinted-url" title={monitor.searchUrl}>
                              {monitor.searchUrl}
                            </span>
                          </TableCell>
                          <TableCell>{intervalText(monitor.intervalMinutes)}</TableCell>
                          <TableCell>
                            {monitor.maxPages} × {monitor.perPage}
                          </TableCell>
                          <TableCell>{itemCounts[monitor.id] ?? 0} 件</TableCell>
                          <TableCell>
                            <div className="vinted-row-title">
                              <Badge variant={statusBadge(monitor.lastStatus)}>
                                {monitor.lastStatus === 'running' ? (
                                  <Loader2
                                    className="size-3 animate-spin"
                                    aria-hidden="true"
                                  />
                                ) : null}
                                {monitor.lastStatus === null
                                  ? '未采集'
                                  : runStatusText(monitor.lastStatus)}
                              </Badge>
                            </div>
                            <div className="vinted-muted">
                              {formatTime(monitor.lastRunAt)}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="vinted-actions">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={starting === monitor.id}
                                onClick={() => void collect(monitor)}
                              >
                                {starting === monitor.id ? (
                                  <Loader2
                                    className="size-3 animate-spin"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Play data-icon="inline-start" />
                                )}
                                采集
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`查看 ${monitor.name} 的采集记录`}
                                onClick={() => setRunsFor(monitor)}
                              >
                                <History />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`查看 ${monitor.name} 的商品`}
                                onClick={() => setItemsFor(monitor)}
                              >
                                <Package />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`编辑 ${monitor.name}`}
                                onClick={() => setEditing({ monitor })}
                              >
                                <Pencil />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`删除 ${monitor.name}`}
                                onClick={() => setRemoving(monitor)}
                              >
                                <Trash2 />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      {editing === null ? null : (
        <MonitorFormSheet
          key={editing.monitor?.id ?? 'new'}
          monitor={editing.monitor}
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          onSaved={() => void refresh()}
        />
      )}

      {runsFor === null ? null : (
        <RunsSheet monitor={runsFor} onOpenChange={() => setRunsFor(null)} />
      )}

      {itemsFor === null ? null : (
        <ItemsSheet monitor={itemsFor} onOpenChange={() => setItemsFor(null)} />
      )}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除监控</AlertDialogTitle>
            <AlertDialogDescription>
              删除「{removing?.name ?? ''}
              」会同时移除它的采集记录与已归档商品；这个操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                void confirmRemove()
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

export function VintedMonitorRoute() {
  const hostAvailable = pluginHostAvailable()
  const [plugin, setPlugin] = useState<PluginView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!hostAvailable) return
    const catalog = await listPlugins()
    setPlugin(catalog.find((entry) => entry.id === VINTED_PLUGIN_ID) ?? null)
  }, [hostAvailable])

  useEffect(() => {
    if (!hostAvailable) return
    let active = true
    void listPlugins().then(
      (catalog) => {
        if (active) {
          setPlugin(catalog.find((entry) => entry.id === VINTED_PLUGIN_ID) ?? null)
        }
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [hostAvailable])

  async function enable() {
    if (plugin === null) return
    setError(null)
    try {
      if (plugin.enabled) await restartPlugin(plugin.id)
      else await enablePlugin(plugin.id, plugin.capabilities)
      await refresh()
    } catch (cause) {
      setError(message(cause))
    }
  }

  return (
    <>
      {error === null ? null : <FieldError role="alert">{error}</FieldError>}
      <VintedMonitorPage
        plugin={plugin}
        hostAvailable={hostAvailable}
        onEnable={enable}
      />
    </>
  )
}
