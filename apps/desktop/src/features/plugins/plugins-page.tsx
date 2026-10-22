import { useCallback, useEffect, useState } from 'react'
import {
  Cable,
  Download,
  Image,
  Info,
  KeyRound,
  Loader2,
  MapPinned,
  Radar,
  RefreshCw,
  ShoppingBag,
  SlidersHorizontal,
  Store,
  Trash2,
  Users,
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
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  installFromMarket,
  installPlugin,
  listPlugins,
  marketStatus,
  pluginHostAvailable,
  refreshMarket,
  setMarketStore,
  uninstallPlugin,
  type MarketStatus,
  type PluginView,
} from '@/lib/platform/native-plugins'
import { BUNDLED_PLUGINS } from './bundled-plugins'

const capabilityIcons = {
  'proxy.provider': Cable,
  'address.generator': MapPinned,
  'supply.catalog': ShoppingBag,
  'platform.adapter': Store,
  'verification.provider': KeyRound,
  'image.provider': Image,
  'environment.configurator': SlidersHorizontal,
  'monitor.collector': Radar,
  'account.pool': Users,
}

function iconFor(capability: string) {
  return capabilityIcons[capability as keyof typeof capabilityIcons] ?? Cable
}

type RowState = 'available' | 'starting' | 'running' | 'retrying' | 'bundled'

interface Row {
  id: string
  name: string
  version: string
  capabilities: string[]
  state: RowState
  plugin: PluginView | null
  sourceDirectory: string | null
}

const stateText: Record<RowState, string> = {
  available: '未安装',
  starting: '启动中',
  running: '运行中',
  retrying: '重试中',
  bundled: '仅桌面应用',
}

/** How often the table re-reads the catalog while a process is coming up. */
const POLL_MS = 3000

function message(error: unknown): string {
  return typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '操作失败，请重试。'
}

function checkedText(seconds: string | null): string {
  if (seconds === null) return '还没检查过'
  const at = Number(seconds)
  if (!Number.isFinite(at) || at <= 0) return '还没检查过'
  const minutes = Math.floor((Date.now() / 1000 - at) / 60)
  if (minutes < 1) return '刚刚检查'
  if (minutes < 60) return `${minutes} 分钟前检查`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前检查`
  return `${Math.floor(hours / 24)} 天前检查`
}

function sizeText(bytes: number): string {
  if (bytes <= 0) return '—'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function PluginsPage() {
  const native = pluginHostAvailable()
  const [plugins, setPlugins] = useState<PluginView[]>([])
  const [market, setMarket] = useState<MarketStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [storeOpen, setStoreOpen] = useState(false)
  const [storeDraft, setStoreDraft] = useState('')
  const [storeError, setStoreError] = useState<string | null>(null)
  const [storeBusy, setStoreBusy] = useState(false)

  const load = useCallback(async () => {
    const [catalog, status] = await Promise.all([listPlugins(), marketStatus()])
    setPlugins(catalog)
    setMarket(status)
  }, [])

  useEffect(() => {
    if (!native) return
    let active = true
    void Promise.all([listPlugins(), marketStatus()]).then(
      ([catalog, status]) => {
        if (!active) return
        setPlugins(catalog)
        setMarket(status)
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [native])

  // The host has no push channel, so a plugin that is still coming up needs the
  // page to look again instead of sitting on a stale badge.
  const pending = plugins.some(
    (plugin) => plugin.state === 'starting' || plugin.state === 'retrying',
  )
  useEffect(() => {
    if (!native || !pending) return
    const timer = setInterval(() => {
      void load()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [native, pending, load])

  const rows: Row[] = native
    ? plugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        capabilities: plugin.capabilities,
        state: plugin.state,
        plugin,
        sourceDirectory: plugin.sourceDirectory,
      }))
    : BUNDLED_PLUGINS.map((manifest) => ({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        capabilities: [...manifest.capabilities],
        state: 'bundled' as const,
        plugin: null,
        sourceDirectory: null,
      }))

  const inspected = plugins.find((plugin) => plugin.id === inspecting) ?? null
  const removingRow = rows.find((row) => row.id === removing) ?? null
  const runningCount = plugins.filter((plugin) => plugin.state === 'running').length
  const updates = new Map((market?.entries ?? []).map((entry) => [entry.id, entry]))
  const updateCount = [...updates.values()].filter(
    (entry) => entry.state === 'update',
  ).length

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key)
    setError(null)
    try {
      await action()
      await load()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(null)
    }
  }

  function openStore() {
    setStoreDraft(market?.storeUrl ?? '')
    setStoreError(null)
    setStoreOpen(true)
  }

  async function saveStore(url: string | null) {
    setStoreBusy(true)
    setStoreError(null)
    try {
      setMarket(await setMarketStore(url))
      setStoreOpen(false)
    } catch (cause) {
      setStoreError(message(cause))
    } finally {
      setStoreBusy(false)
    }
  }

  return (
    <section className="collection-page page-reveal" aria-labelledby="plugins-heading">
      <div className="section-intro">
        <h1 className="page-heading" id="plugins-heading">
          插件中心
        </h1>
        <div className="section-actions">
          <Button
            variant="ghost"
            disabled={!native || busy !== null || storeBusy}
            onClick={() => {
              void run('refresh', async () => {
                if (market?.storeUrl) await refreshMarket()
              })
            }}
          >
            <RefreshCw data-icon="inline-start" />
            检查更新
          </Button>
          <Button variant="ghost" disabled={!native} onClick={openStore}>
            <Store data-icon="inline-start" />
            商店设置
          </Button>
        </div>
      </div>

      {error ? <FieldError role="alert">{error}</FieldError> : null}

      {native && rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>还没有插件</EmptyTitle>
            <EmptyDescription>
              {market?.storeUrl
                ? '到下面的插件商店安装需要的插件。'
                : '配置插件商店地址后即可安装。'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="plugin-panel">
          <div className="panel-heading">
            <h2>插件</h2>
            <Badge variant="secondary">{rows.length}</Badge>
            <span>{native ? `${runningCount} 个运行中` : ''}</span>
            {updateCount > 0 ? (
              <Badge variant="outline">{updateCount} 个可更新</Badge>
            ) : null}
          </div>
          <Table aria-label="插件列表">
            <TableHeader>
              <TableRow>
                <TableHead>插件</TableHead>
                <TableHead>能力</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const Icon = iconFor(row.capabilities[0] ?? '')
                const published = updates.get(row.id)
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="plugin-cell">
                        <span className="plugin-icon">
                          <Icon />
                        </span>
                        <div className="plugin-cell-text">
                          <strong>{row.name}</strong>
                          <code className="plugin-id">{row.id}</code>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="capability-name">
                        {row.capabilities.join(' · ') || '—'}
                      </code>
                    </TableCell>
                    <TableCell>
                      <span className="plugin-version">
                        v{row.version}
                        {published?.state === 'update' ? (
                          <Badge variant="outline">→ v{published.version}</Badge>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.state === 'running' ? 'secondary' : 'outline'}>
                        {row.state === 'starting' || row.state === 'retrying' ? (
                          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                        ) : null}
                        {stateText[row.state]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="plugin-actions">
                        {row.state === 'available' ? (
                          <Button
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => {
                              void run(`install-${row.id}`, async () => {
                                await installPlugin(row.sourceDirectory ?? '')
                              })
                            }}
                          >
                            <Download data-icon="inline-start" />
                            安装
                          </Button>
                        ) : null}
                        {published?.state === 'update' ? (
                          <Button
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => {
                              void run(`update-${row.id}`, async () => {
                                await installFromMarket(row.id)
                              })
                            }}
                          >
                            <Download data-icon="inline-start" />
                            更新
                          </Button>
                        ) : null}
                        {row.plugin === null ? null : (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`查看 ${row.name} 的清单`}
                            onClick={() => setInspecting(row.id)}
                          >
                            <Info />
                          </Button>
                        )}
                        {row.plugin === null || row.state === 'available' ? null : (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`卸载 ${row.name}`}
                            disabled={busy !== null}
                            onClick={() => setRemoving(row.id)}
                          >
                            <Trash2 />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {native && market !== null ? (
        <div className="plugin-panel store-panel">
          <div className="panel-heading">
            <h2>插件商店</h2>
            {market.storeUrl === null ? null : (
              <code className="plugin-id">{market.storeUrl}</code>
            )}
            <span>
              {market.storeUrl === null ? '' : checkedText(market.lastCheckedAt)}
            </span>
          </div>
          {market.lastError ? (
            <FieldError role="alert">{market.lastError}</FieldError>
          ) : null}
          {market.storeUrl === null ? (
            <div className="store-empty">
              <p>还没有配置商店地址。</p>
              <Button size="sm" variant="outline" onClick={openStore}>
                填写地址
              </Button>
            </div>
          ) : market.entries.length === 0 ? (
            <p className="store-empty">这个商店还没有发布插件。</p>
          ) : (
            <Table aria-label="商店插件列表">
              <TableHeader>
                <TableRow>
                  <TableHead>插件</TableHead>
                  <TableHead>版本</TableHead>
                  <TableHead>大小</TableHead>
                  <TableHead>说明</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {market.entries.map((entry) => {
                  const Icon = iconFor(entry.capabilities[0] ?? '')
                  return (
                    <TableRow key={entry.id}>
                      <TableCell>
                        <div className="plugin-cell">
                          <span className="plugin-icon">
                            <Icon />
                          </span>
                          <div className="plugin-cell-text">
                            <strong>{entry.name}</strong>
                            <code className="plugin-id">{entry.id}</code>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>v{entry.version}</TableCell>
                      <TableCell>{sizeText(entry.size)}</TableCell>
                      <TableCell className="store-description">
                        {entry.changelog || entry.description || '—'}
                      </TableCell>
                      <TableCell>
                        <div className="plugin-actions">
                          {entry.state === 'current' ? (
                            <Badge variant="secondary">已是最新</Badge>
                          ) : (
                            <Button
                              size="sm"
                              disabled={busy !== null || storeBusy}
                              onClick={() => {
                                void run(`${entry.state}-${entry.id}`, async () => {
                                  await installFromMarket(entry.id)
                                })
                              }}
                            >
                              <Download data-icon="inline-start" />
                              {entry.state === 'update' ? '更新' : '安装'}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </div>
      ) : null}

      <Dialog
        open={inspecting !== null}
        onOpenChange={(open) => {
          if (!open) setInspecting(null)
        }}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{inspected?.name}</DialogTitle>
          </DialogHeader>
          <dl className="about-details">
            <div className="about-row">
              <dt>插件标识</dt>
              <dd>
                <code>{inspected?.id}</code>
              </dd>
            </div>
            <div className="about-row">
              <dt>版本</dt>
              <dd>
                {inspected?.version} · API {inspected?.apiVersion} · 最低核心{' '}
                {inspected?.minCoreVersion}
              </dd>
            </div>
            <div className="about-row">
              <dt>能力</dt>
              <dd>
                <code>{inspected?.capabilities.join(' · ')}</code>
              </dd>
            </div>
            <div className="about-row">
              <dt>方法</dt>
              <dd>{inspected?.methods.length ?? 0} 个</dd>
            </div>
            <div className="about-row">
              <dt>网络域名</dt>
              <dd>{inspected?.permissions.networkDomains.join('、') || '未申请'}</dd>
            </div>
            <div className="about-row">
              <dt>密钥槽</dt>
              <dd>{inspected?.secretSlots.join('、') || '未申请'}</dd>
            </div>
            <div className="about-row">
              <dt>状态</dt>
              <dd>
                {inspected ? stateText[inspected.state] : ''}
                {inspected?.lastError ? ` · ${inspected.lastError}` : ''}
              </dd>
            </div>
          </dl>
          <DialogFooter>
            <Button onClick={() => setInspecting(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={storeOpen}
        onOpenChange={(open) => {
          if (!open) setStoreOpen(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>插件商店地址</DialogTitle>
            <DialogDescription>
              填写商店根地址或 catalog.json 的完整地址，保存后会立即检查一次。
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="插件商店地址"
            placeholder="https://market.example.com/nexus-studio-market"
            value={storeDraft}
            disabled={storeBusy}
            onChange={(event) => setStoreDraft(event.target.value)}
          />
          {storeError ? <FieldError role="alert">{storeError}</FieldError> : null}
          <DialogFooter>
            {market?.storeUrl ? (
              <Button
                variant="ghost"
                disabled={storeBusy}
                onClick={() => {
                  void saveStore(null)
                }}
              >
                清除
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={storeBusy}
              onClick={() => setStoreOpen(false)}
            >
              取消
            </Button>
            <Button
              disabled={storeBusy || storeDraft.trim() === ''}
              onClick={() => {
                void saveStore(storeDraft)
              }}
            >
              {storeBusy ? (
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              ) : null}
              保存并检查
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={removingRow !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>卸载 {removingRow?.name}</AlertDialogTitle>
            <AlertDialogDescription>
              插件文件与它保存的数据都会被删除，重新使用需要再次安装。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                const target = removingRow
                if (target === null) return
                setRemoving(null)
                void run(`uninstall-${target.id}`, async () => {
                  await uninstallPlugin(target.id)
                })
              }}
            >
              卸载
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
