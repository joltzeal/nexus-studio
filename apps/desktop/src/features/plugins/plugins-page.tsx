import { useCallback, useEffect, useState } from 'react'
import {
  Cable,
  Download,
  Image,
  Info,
  KeyRound,
  Loader2,
  MapPinned,
  Mail,
  Package,
  Radar,
  Radio,
  RefreshCw,
  Bot,
  ShoppingBag,
  SlidersHorizontal,
  Store,
  Trash2,
  Users,
} from '@/components/icons'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  activatePluginLicense,
  installFromMarket,
  installPlugin,
  listPlugins,
  marketStatus,
  pluginHostAvailable,
  pluginLicenseStatus,
  refreshMarket,
  setMarketStore,
  uninstallPlugin,
  type MarketStatus,
  type PluginView,
  type PluginLicenseStatus,
} from '@/lib/platform/native-plugins'
import { installPendingUpdates, pendingPluginUpdates } from './bulk-update'
import { hasUsablePluginLicense, requiresPluginLicense } from './first-party-licensing'

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
  'window.sync': Radio,
  'email.provider': Mail,
  'product.catalog': Package,
  'sales.agent': Bot,
}

function iconFor(capability: string) {
  return capabilityIcons[capability as keyof typeof capabilityIcons] ?? Cable
}

function capabilityLabel(capability: string) {
  return capability === 'window.sync' ? '设备同步 (window.sync)' : capability
}

type RowState = 'available' | 'starting' | 'running' | 'retrying' | 'unlicensed'

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
  unlicensed: '未激活',
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
  const [updateProgress, setUpdateProgress] = useState<string | null>(null)
  const [updateResult, setUpdateResult] = useState<string | null>(null)
  const [licenses, setLicenses] = useState<Record<string, PluginLicenseStatus>>({})
  const [licenseOpen, setLicenseOpen] = useState(false)
  const [licenseTarget, setLicenseTarget] = useState<{ id: string; name: string } | null>(
    null,
  )
  const [cardDraft, setCardDraft] = useState('')
  const [licenseError, setLicenseError] = useState<string | null>(null)
  const [licenseBusy, setLicenseBusy] = useState(false)

  const load = useCallback(async () => {
    const [catalog, status, entitlement] = await Promise.all([
      listPlugins(),
      marketStatus(),
      pluginLicenseStatus(),
    ])
    setPlugins(catalog)
    setMarket(status)
    setLicenses(entitlement)
  }, [])

  useEffect(() => {
    if (!native) return
    let active = true
    void Promise.all([listPlugins(), marketStatus(), pluginLicenseStatus()]).then(
      ([catalog, status, entitlement]) => {
        if (!active) return
        setPlugins(catalog)
        setMarket(status)
        setLicenses(entitlement)
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
    : []

  const inspected = plugins.find((plugin) => plugin.id === inspecting) ?? null
  const removingRow = rows.find((row) => row.id === removing) ?? null
  const installedCount = plugins.filter((plugin) => plugin.state !== 'available').length
  const runningCount = plugins.filter((plugin) => plugin.state === 'running').length
  const updates = new Map((market?.entries ?? []).map((entry) => [entry.id, entry]))
  const pluginIds = [
    ...new Set([
      ...(market?.entries ?? []).map((entry) => entry.id),
      ...plugins.map((entry) => entry.id),
    ]),
  ]
  const licensedPluginIds = new Set(
    pluginIds.filter(
      (id) => !requiresPluginLicense(id) || hasUsablePluginLicense(licenses[id]?.state),
    ),
  )
  const pendingUpdates = pendingPluginUpdates(
    market?.entries ?? [],
    plugins,
    licensedPluginIds,
  )
  const updateCount = pendingUpdates.length
  const skippedUpdateCount = (market?.entries ?? []).filter(
    (entry) =>
      entry.state === 'update' &&
      plugins.some((plugin) => plugin.id === entry.id && plugin.state !== 'available') &&
      requiresPluginLicense(entry.id) &&
      licenses[entry.id]?.state !== 'active',
  ).length
  const unlicensedCount = pluginIds.filter(
    (id) => requiresPluginLicense(id) && !hasUsablePluginLicense(licenses[id]?.state),
  ).length

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key)
    setError(null)
    setUpdateResult(null)
    try {
      await action()
      await load()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(null)
    }
  }

  async function updateAll() {
    if (busy !== null || storeBusy || !market?.storeUrl) return
    setBusy('bulk-update')
    setError(null)
    setUpdateResult(null)
    try {
      const [freshMarket, freshPlugins, freshLicenses] = await Promise.all([
        refreshMarket(),
        listPlugins(),
        pluginLicenseStatus(),
      ])
      setMarket(freshMarket)
      setPlugins(freshPlugins)
      setLicenses(freshLicenses)
      const ids = [
        ...new Set([
          ...freshMarket.entries.map((entry) => entry.id),
          ...freshPlugins.map((entry) => entry.id),
        ]),
      ]
      const freshLicensedIds = new Set(
        ids.filter(
          (id) =>
            !requiresPluginLicense(id) ||
            hasUsablePluginLicense(freshLicenses[id]?.state),
        ),
      )
      const installedIds = new Set(
        freshPlugins
          .filter((plugin) => plugin.state !== 'available')
          .map((plugin) => plugin.id),
      )
      const allUpdates = freshMarket.entries.filter(
        (entry) => entry.state === 'update' && installedIds.has(entry.id),
      )
      const candidates = pendingPluginUpdates(
        freshMarket.entries,
        freshPlugins,
        freshLicensedIds,
      )
      const skipped = allUpdates.filter((entry) => !freshLicensedIds.has(entry.id)).length
      if (candidates.length === 0) {
        setUpdateResult(
          skipped > 0
            ? `有 ${skipped} 个更新因未激活而跳过。`
            : '所有已安装插件均为最新版本。',
        )
        return
      }
      const { updated, failures } = await installPendingUpdates(
        candidates,
        installFromMarket,
        (entry, index, total) =>
          setUpdateProgress(`正在更新 ${index}/${total}：${entry.name}`),
      )
      setUpdateResult(
        `已更新 ${updated}/${candidates.length} 个插件。${skipped > 0 ? `另有 ${skipped} 个未激活插件已跳过。` : ''}`,
      )
      if (failures.length)
        setError(
          failures
            .map(({ entry, error }) => `${entry.name}：${message(error)}`)
            .join('；'),
        )
    } catch (cause) {
      setError(message(cause))
    } finally {
      setUpdateProgress(null)
      try {
        await load()
      } catch (cause) {
        setError((previous) =>
          [previous, `刷新插件列表失败：${message(cause)}`].filter(Boolean).join('；'),
        )
      }
      setBusy(null)
    }
  }

  function openStore() {
    setStoreDraft(market?.storeUrl ?? '')
    setStoreError(null)
    setStoreOpen(true)
  }

  async function activate() {
    if (licenseBusy || !cardDraft.trim() || !licenseTarget) return
    setLicenseBusy(true)
    setLicenseError(null)
    try {
      const status = await activatePluginLicense(licenseTarget.id, cardDraft.trim())
      setLicenses((previous) => ({ ...previous, [licenseTarget.id]: status }))
      setCardDraft('')
      setLicenseOpen(false)
      setLicenseTarget(null)
      await load()
    } catch (cause) {
      setLicenseError(message(cause))
    } finally {
      setLicenseBusy(false)
    }
  }

  function openActivation(id: string, name: string) {
    setLicenseTarget({ id, name })
    setLicenseError(null)
    setLicenseOpen(true)
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
    <section className="collection-page flex min-w-0 flex-col gap-3" aria-labelledby="plugins-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold leading-tight" id="plugins-heading">
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

      {!native ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>仅桌面应用</EmptyTitle>
            <EmptyDescription>请在桌面应用中查看与管理插件。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="plugins-workspace">
          <div className="plugin-overview" aria-label="插件概览">
            <div>
              <strong>{installedCount}</strong>
              <span>已安装</span>
            </div>
            <div>
              <strong>{runningCount}</strong>
              <span>运行中</span>
            </div>
            <div>
              <strong>{unlicensedCount}</strong>
              <span>待激活</span>
            </div>
            <div>
              <strong>{updateCount}</strong>
              <span>可更新</span>
            </div>
          </div>
          <Tabs defaultValue="installed" className="plugin-tabs">
            <div className="plugin-tabs-bar">
              <TabsList aria-label="插件视图">
                <TabsTrigger value="installed">
                  已安装 <span>{installedCount}</span>
                </TabsTrigger>
                <TabsTrigger value="market">
                  插件商店 <span>{market?.entries.length ?? 0}</span>
                </TabsTrigger>
              </TabsList>
              {market?.storeUrl ? (
                <span className="plugin-store-meta">
                  {checkedText(market.lastCheckedAt)}
                </span>
              ) : null}
            </div>
            <TabsContent value="installed">
              <div className="plugin-panel">
                <div className="panel-heading">
                  <h2>已安装插件</h2>
                  <span>
                    {updateCount > 0 ? `${updateCount} 个更新可用` : '当前均为最新版本'}
                  </span>
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
                    {rows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="plugin-table-empty">
                          暂无已安装插件，可前往插件商店查看。
                        </TableCell>
                      </TableRow>
                    ) : (
                      rows.map((row) => {
                        const Icon = iconFor(row.capabilities[0] ?? '')
                        const published = updates.get(row.id)
                        const entitlement = licenses[row.id]
                        const licensed =
                          !requiresPluginLicense(row.id) ||
                          hasUsablePluginLicense(entitlement?.state)
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
                                {row.capabilities.map(capabilityLabel).join(' · ') || '—'}
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
                              <div className="plugin-status-cell">
                                <Badge
                                  variant={
                                    row.state === 'running' ? 'secondary' : 'outline'
                                  }
                                >
                                  {row.state === 'starting' ||
                                  row.state === 'retrying' ? (
                                    <Loader2
                                      className="size-3 animate-spin"
                                      aria-hidden="true"
                                    />
                                  ) : null}
                                  {stateText[row.state]}
                                </Badge>
                                {requiresPluginLicense(row.id) ? (
                                  <span
                                    className={
                                      licensed
                                        ? 'plugin-license-state is-active'
                                        : 'plugin-license-state'
                                    }
                                  >
                                    {licensed
                                      ? entitlement?.expiresAt
                                        ? `${entitlement?.state === 'needsConnection' ? '离线可用至' : '已激活至'} ${new Date(entitlement.expiresAt * 1000).toLocaleDateString()}`
                                        : '已激活'
                                      : entitlement?.state === 'expired'
                                        ? '授权已过期'
                                        : '需要激活'}
                                  </span>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="plugin-actions">
                                {row.state === 'available' ? (
                                  <Button
                                    size="sm"
                                    disabled={
                                      busy !== null ||
                                      (!licensed && requiresPluginLicense(row.id))
                                    }
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
                                {requiresPluginLicense(row.id) ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => openActivation(row.id, row.name)}
                                  >
                                    <KeyRound data-icon="inline-start" />
                                    {licensed ? '授权有效' : '激活'}
                                  </Button>
                                ) : null}
                                {published?.state === 'update' ? (
                                  <Button
                                    size="sm"
                                    disabled={
                                      busy !== null ||
                                      (!licensed && requiresPluginLicense(row.id))
                                    }
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
                                {row.plugin !== null &&
                                row.sourceDirectory !== null &&
                                published?.state !== 'update' ? (
                                  // A package rebuilt from a directory keeps its
                                  // version, so without this the app would keep running
                                  // the copy it installed the first time.
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={
                                      busy !== null ||
                                      (!licensed && requiresPluginLicense(row.id))
                                    }
                                    title={`重新安装自 ${row.sourceDirectory}`}
                                    onClick={() => {
                                      void run(`reinstall-${row.id}`, async () => {
                                        await installPlugin(row.sourceDirectory ?? '')
                                      })
                                    }}
                                  >
                                    <RefreshCw data-icon="inline-start" />
                                    重新安装
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
                                {row.plugin === null ||
                                row.state === 'available' ? null : (
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
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="market">
              {market !== null ? (
                <div className="plugin-panel store-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>插件商店</h2>
                      <p>按需安装官方插件，激活后即可使用。</p>
                    </div>
                    <Button size="sm" variant="outline" onClick={openStore}>
                      <Store data-icon="inline-start" />
                      商店设置
                    </Button>
                    <Button
                      className="store-update-all"
                      size="sm"
                      variant="outline"
                      disabled={
                        busy !== null ||
                        storeBusy ||
                        !market.storeUrl ||
                        (pendingUpdates.length === 0 && skippedUpdateCount === 0)
                      }
                      onClick={() => void updateAll()}
                    >
                      {busy === 'bulk-update' ? (
                        <Loader2 className="animate-spin" data-icon="inline-start" />
                      ) : (
                        <Download data-icon="inline-start" />
                      )}
                      全部更新
                      {pendingUpdates.length > 0 ? ` (${pendingUpdates.length})` : ''}
                    </Button>
                  </div>
                  {updateProgress ? (
                    <p className="store-update-feedback" role="status">
                      {updateProgress}
                    </p>
                  ) : null}
                  {updateResult ? (
                    <p className="store-update-feedback" role="status">
                      {updateResult}
                    </p>
                  ) : null}
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
                          const entitlement = licenses[entry.id]
                          const licensed = hasUsablePluginLicense(entitlement?.state)
                          return (
                            <TableRow key={entry.id}>
                              <TableCell>
                                <div className="plugin-cell">
                                  <span
                                    className="plugin-icon"
                                    title={entry.capabilities
                                      .map(capabilityLabel)
                                      .join(' · ')}
                                  >
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
                                      disabled={
                                        busy !== null ||
                                        storeBusy ||
                                        (!licensed && requiresPluginLicense(entry.id))
                                      }
                                      onClick={() => {
                                        void run(
                                          `${entry.state}-${entry.id}`,
                                          async () => {
                                            await installFromMarket(entry.id)
                                          },
                                        )
                                      }}
                                    >
                                      <Download data-icon="inline-start" />
                                      {entry.state === 'update' ? '更新' : '安装'}
                                    </Button>
                                  )}
                                  {requiresPluginLicense(entry.id) ? (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => openActivation(entry.id, entry.name)}
                                    >
                                      <KeyRound data-icon="inline-start" />
                                      {licensed ? '授权有效' : '激活'}
                                    </Button>
                                  ) : null}
                                </div>
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  )}
                </div>
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>尚未配置插件商店</EmptyTitle>
                    <EmptyDescription>
                      添加商店地址后，即可浏览并安装插件。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}

      <Dialog
        open={licenseOpen}
        onOpenChange={(open) => {
          if (!open && !licenseBusy) setLicenseOpen(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>激活 {licenseTarget?.name ?? '插件'}</DialogTitle>
            <DialogDescription>
              {licenseTarget &&
              licenses[licenseTarget.id]?.state === 'active' &&
              licenses[licenseTarget.id]?.expiresAt
                ? `当前设备已激活，有效至 ${new Date(licenses[licenseTarget.id]!.expiresAt! * 1000).toLocaleString()}。`
                : '输入该插件对应的激活码，首次激活需要联网。'}
            </DialogDescription>
            {licenseTarget ? (
              <code className="plugin-license-id">{licenseTarget.id}</code>
            ) : null}
          </DialogHeader>
          <Input
            aria-label="插件激活码"
            placeholder="RAC-..."
            value={cardDraft}
            disabled={licenseBusy}
            onChange={(event) => setCardDraft(event.target.value)}
          />
          {licenseError ? <FieldError role="alert">{licenseError}</FieldError> : null}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={licenseBusy}
              onClick={() => {
                setLicenseOpen(false)
                setLicenseTarget(null)
              }}
            >
              取消
            </Button>
            <Button
              disabled={licenseBusy || !cardDraft.trim()}
              onClick={() => void activate()}
            >
              {licenseBusy ? (
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              ) : null}
              激活
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                <code>{inspected?.capabilities.map(capabilityLabel).join(' · ')}</code>
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
            placeholder="https://market.example.com/raccoon-market"
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
