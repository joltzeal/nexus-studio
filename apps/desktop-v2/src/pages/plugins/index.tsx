import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  AlertModal,
  Badge,
  Button,
  DataList,
  DialogModal,
  EmptyState,
  Input,
  Modal,
  SegmentControl,
  type DataListColumn,
  type MenuItem,
} from '@proxyshard/shardx-ui-kit'
import {
  DeleteIcon,
  DownloadIcon,
  ExternalLinkIcon,
  InfoIcon,
  KeyIcon,
  NavExtensionsIcon,
  NavSettingsIcon,
  RefreshIcon,
} from '../../shared/icons'
import { ListColumn } from '../../shared/ui/ListColumn'
import { PageHeader } from '../../widgets/PageHeader'
import { PluginFilterRow, PluginSearch } from './PluginFilterRow'
import { PluginRowAction } from './PluginRowAction'
import { PluginWorkspace } from './PluginWorkspace'
import { PluginConfigurationDialog } from './PluginConfigurationDialog'
import { PluginNavigationIcon } from '../../raccoon/plugins/PluginNavigationIcon'
import { pluginApi } from '../../raccoon/plugins/api'
import {
  hasUsablePluginLicense,
  requiresPluginLicense,
} from '../../raccoon/plugins/licensing'
import type {
  MarketEntry,
  MarketStatus,
  PluginLicenseStatus,
  PluginState,
  PluginView,
} from '../../raccoon/plugins/types'

type PluginTab = 'installed' | 'market'
type PageStatus = 'loading' | 'ready' | 'error'

type PluginRow = {
  kind: PluginTab
  id: string
  name: string
  version: string
  capabilities: string[]
  description: string
  plugin: PluginView | null
  market: MarketEntry | null
}

const STATE_LABELS: Record<PluginState, string> = {
  available: '本地可安装',
  starting: '启动中',
  running: '运行中',
  retrying: '后台重试',
  unlicensed: '需要激活',
}

const STATE_COLORS: Record<PluginState, 'gray' | 'information' | 'success' | 'warning'> =
  {
    available: 'gray',
    starting: 'information',
    running: 'success',
    retrying: 'warning',
    unlicensed: 'warning',
  }

function checkedText(seconds: string | null): string {
  if (seconds === null) return '尚未检查'
  const at = Number(seconds)
  if (!Number.isFinite(at) || at <= 0) return '尚未检查'
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - at) / 60))
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : typeof cause === 'string'
      ? cause
      : '插件操作失败，请重试'
}

function capabilityText(capabilities: string[]): string {
  return capabilities.join(' · ') || '未声明能力'
}

function licenseText(status: PluginLicenseStatus | undefined): string {
  if (!status || status.state === 'inactive') return '需要激活'
  if (status.state === 'expired') return '授权已过期'
  if (status.state === 'invalid') return '授权无效'
  if (status.state === 'needsConnection') {
    return status.expiresAt
      ? `离线可用至 ${new Date(status.expiresAt * 1000).toLocaleDateString()}`
      : '需要联网核验'
  }
  return status.expiresAt
    ? `已激活至 ${new Date(status.expiresAt * 1000).toLocaleDateString()}`
    : '已激活'
}

export function PluginsPage({
  onOpenPlugin,
}: { onOpenPlugin?: (id: string) => void } = {}) {
  const [tab, setTab] = useState<PluginTab>('installed')
  const [status, setStatus] = useState<PageStatus>('loading')
  const [plugins, setPlugins] = useState<PluginView[]>([])
  const [market, setMarket] = useState<MarketStatus | null>(null)
  const [licenses, setLicenses] = useState<Record<string, PluginLicenseStatus>>({})
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState<PluginView | null>(null)
  const [marketInspecting, setMarketInspecting] = useState<MarketEntry | null>(null)
  const [removing, setRemoving] = useState<PluginView | null>(null)
  const [storeOpen, setStoreOpen] = useState(false)
  const [configurationOpen, setConfigurationOpen] = useState(false)
  const [storeDraft, setStoreDraft] = useState('')
  const [storeError, setStoreError] = useState<string | null>(null)
  const [licenseTarget, setLicenseTarget] = useState<{ id: string; name: string } | null>(
    null,
  )
  const [cardDraft, setCardDraft] = useState('')
  const [licenseError, setLicenseError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [catalog, store, entitlement] = await Promise.all([
      pluginApi.list(),
      pluginApi.marketStatus(),
      pluginApi.licenseStatus(),
    ])
    setPlugins(catalog)
    setMarket(store)
    setLicenses(entitlement)
    window.dispatchEvent(new Event('raccoon:plugin-catalog-changed'))
  }, [])

  const initialize = useCallback(async () => {
    setStatus('loading')
    setError(null)
    try {
      await load()
      setStatus('ready')
    } catch (cause) {
      setError(errorMessage(cause))
      setStatus('error')
    }
  }, [load])

  useEffect(() => {
    void initialize()
  }, [initialize])

  const pending = plugins.some(
    (plugin) => plugin.state === 'starting' || plugin.state === 'retrying',
  )
  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => {
      void load().catch(() => {})
    }, 3000)
    return () => window.clearInterval(timer)
  }, [pending, load])

  const installed = plugins.filter((plugin) => plugin.state !== 'available')
  const installedIds = new Set(
    installed
      .filter((plugin) => plugin.source !== 'workspace')
      .map((plugin) => plugin.id),
  )
  const updates = new Map((market?.entries ?? []).map((entry) => [entry.id, entry]))
  const updateCount = (market?.entries ?? []).filter(
    (entry) => entry.state === 'update' && installedIds.has(entry.id),
  ).length
  const runningCount = installed.filter((plugin) => plugin.state === 'running').length
  const unlicensedCount = new Set([
    ...plugins
      .filter(
        (plugin) =>
          plugin.source !== 'workspace' &&
          requiresPluginLicense(plugin.id) &&
          !hasUsablePluginLicense(licenses[plugin.id]?.state),
      )
      .map((plugin) => plugin.id),
    ...(market?.entries ?? [])
      .filter(
        (entry) =>
          !plugins.some(
            (plugin) => plugin.id === entry.id && plugin.source === 'workspace',
          ) &&
          requiresPluginLicense(entry.id) &&
          !hasUsablePluginLicense(licenses[entry.id]?.state),
      )
      .map((entry) => entry.id),
  ]).size

  const rows = useMemo<PluginRow[]>(() => {
    const source =
      tab === 'installed'
        ? plugins.map((plugin) => ({
            kind: 'installed' as const,
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            capabilities: plugin.capabilities,
            description:
              plugin.lastError ??
              (plugin.state === 'available'
                ? '本地开发目录中发现的插件包'
                : capabilityText(plugin.capabilities)),
            plugin,
            market: updates.get(plugin.id) ?? null,
          }))
        : (market?.entries ?? []).map((entry) => ({
            kind: 'market' as const,
            id: entry.id,
            name: entry.name,
            version: entry.version,
            capabilities: entry.capabilities,
            description:
              entry.changelog || entry.description || capabilityText(entry.capabilities),
            plugin:
              plugins.find(
                (plugin) => plugin.id === entry.id && plugin.state !== 'available',
              ) ?? null,
            market: entry,
          }))
    const query = search.trim().toLowerCase()
    if (!query) return source
    return source.filter(
      (row) =>
        row.name.toLowerCase().includes(query) ||
        row.id.toLowerCase().includes(query) ||
        row.description.toLowerCase().includes(query) ||
        row.capabilities.some((capability) => capability.toLowerCase().includes(query)),
    )
  }, [market?.entries, plugins, search, tab, updates])

  async function run(
    key: string,
    action: () => Promise<void>,
    success?: string,
  ): Promise<boolean> {
    if (busy !== null) return false
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      await action()
      if (success) setNotice(success)
      try {
        await load()
      } catch (cause) {
        setError(`操作已完成，刷新插件列表失败：${errorMessage(cause)}`)
      }
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setBusy(null)
    }
  }

  function openStore() {
    setStoreDraft(market?.storeUrl ?? '')
    setStoreError(null)
    setStoreOpen(true)
  }

  function openLicense(id: string, name: string) {
    setLicenseTarget({ id, name })
    setCardDraft('')
    setLicenseError(null)
  }

  function closeLicense() {
    setLicenseTarget(null)
    setCardDraft('')
    setLicenseError(null)
  }

  async function saveStore(url: string | null) {
    if (busy !== null) return
    setBusy('store')
    setStoreError(null)
    try {
      setMarket(await pluginApi.setMarketStore(url))
      setStoreOpen(false)
    } catch (cause) {
      setStoreError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function activate() {
    if (!licenseTarget || !cardDraft.trim() || busy !== null) return
    setBusy(`license:${licenseTarget.id}`)
    setLicenseError(null)
    try {
      const activated = await pluginApi.activate(licenseTarget.id, cardDraft.trim())
      setLicenses((current) => ({ ...current, [licenseTarget.id]: activated }))
      closeLicense()
      try {
        await load()
      } catch (cause) {
        setError(`插件已激活，刷新插件列表失败：${errorMessage(cause)}`)
      }
    } catch (cause) {
      setLicenseError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function updateAll() {
    if (!market?.storeUrl || busy !== null) return
    setBusy('update-all')
    setError(null)
    setNotice(null)
    try {
      const freshMarket = await pluginApi.refreshMarket()
      const [freshPlugins, freshLicenses] = await Promise.all([
        pluginApi.list(),
        pluginApi.licenseStatus(),
      ])
      setMarket(freshMarket)
      setPlugins(freshPlugins)
      setLicenses(freshLicenses)
      const freshInstalledIds = new Set(
        freshPlugins
          .filter((plugin) => plugin.state !== 'available')
          .map((plugin) => plugin.id),
      )
      const availableUpdates = freshMarket.entries.filter(
        (entry) =>
          entry.state === 'update' &&
          freshInstalledIds.has(entry.id) &&
          !freshPlugins.some(
            (plugin) => plugin.id === entry.id && plugin.source === 'workspace',
          ),
      )
      const candidates = availableUpdates.filter(
        (entry) =>
          !requiresPluginLicense(entry.id) ||
          hasUsablePluginLicense(freshLicenses[entry.id]?.state),
      )
      const skipped = availableUpdates.length - candidates.length
      const failures: string[] = []
      let updated = 0
      for (const [index, entry] of candidates.entries()) {
        setNotice(`正在更新 ${index + 1}/${candidates.length} · ${entry.name}`)
        try {
          await pluginApi.installMarket(entry.id)
          updated++
        } catch (cause) {
          failures.push(`${entry.name}：${errorMessage(cause)}`)
        }
      }
      let refreshFailure: string | null = null
      try {
        await load()
      } catch (cause) {
        refreshFailure = `刷新插件列表失败：${errorMessage(cause)}`
      }
      setNotice(
        candidates.length === 0
          ? skipped > 0
            ? `有 ${skipped} 个更新需要先激活插件`
            : '当前没有可安装的更新'
          : `已更新 ${updated}/${candidates.length} 个插件${skipped > 0 ? `，另有 ${skipped} 个需要先激活` : ''}`,
      )
      const messages = [...failures, ...(refreshFailure ? [refreshFailure] : [])]
      if (messages.length > 0) setError(messages.join('；'))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  function licensed(id: string): boolean {
    return (
      plugins.some((plugin) => plugin.id === id && plugin.source === 'workspace') ||
      !requiresPluginLicense(id) ||
      hasUsablePluginLicense(licenses[id]?.state)
    )
  }

  function primaryAction(row: PluginRow) {
    if (!licensed(row.id)) {
      return (
        <PluginRowAction
          label="激活插件"
          icon={<KeyIcon className="size-3.5" />}
          disabled={busy !== null}
          onClick={() => openLicense(row.id, row.name)}
        />
      )
    }
    if (row.plugin?.source === 'workspace') {
      return (
        <Badge size="small" color="information">
          源码调试
        </Badge>
      )
    }
    if (row.kind === 'market') {
      if (row.market?.state === 'current')
        return (
          <Badge size="small" color="success">
            已安装
          </Badge>
        )
      return (
        <PluginRowAction
          label={row.market?.state === 'update' ? '更新插件' : '安装插件'}
          icon={
            row.market?.state === 'update' ? (
              <RefreshIcon className="size-3.5" />
            ) : (
              <DownloadIcon className="size-3.5" />
            )
          }
          isLoading={busy === `market:${row.id}`}
          disabled={busy !== null}
          onClick={() =>
            void run(
              `market:${row.id}`,
              () => pluginApi.installMarket(row.id).then(() => {}),
              row.market?.state === 'update'
                ? `已更新 ${row.name}`
                : `已安装 ${row.name}`,
            )
          }
        />
      )
    }
    if (row.plugin?.state === 'available') {
      return (
        <PluginRowAction
          label="安装本地插件"
          icon={<DownloadIcon className="size-3.5" />}
          isLoading={busy === `local:${row.id}`}
          disabled={busy !== null || !row.plugin.sourceDirectory}
          onClick={() =>
            void run(
              `local:${row.id}`,
              () =>
                pluginApi.installLocal(row.plugin?.sourceDirectory ?? '').then(() => {}),
              `已安装 ${row.name}`,
            )
          }
        />
      )
    }
    if (row.market?.state === 'update') {
      return (
        <PluginRowAction
          label="更新插件"
          icon={<RefreshIcon className="size-3.5" />}
          isLoading={busy === `update:${row.id}`}
          disabled={busy !== null}
          onClick={() =>
            void run(
              `update:${row.id}`,
              () => pluginApi.installMarket(row.id).then(() => {}),
              `已更新 ${row.name}`,
            )
          }
        />
      )
    }
    if (onOpenPlugin && row.plugin?.enabled)
      return (
        <PluginRowAction
          label="打开插件页面"
          icon={<ExternalLinkIcon className="size-3.5" />}
          onClick={() => onOpenPlugin(row.id)}
        />
      )
    return null
  }

  function menuItems(row: PluginRow): MenuItem[] {
    const items: MenuItem[] = []
    if (row.plugin) {
      items.push({
        label: '查看清单',
        icon: <InfoIcon className="size-3.5" />,
        onSelect: () => setInspecting(row.plugin),
      })
    }
    if (row.market) {
      items.push({
        label: '查看发布信息',
        icon: <InfoIcon className="size-3.5" />,
        onSelect: () => setMarketInspecting(row.market),
      })
    }
    if (requiresPluginLicense(row.id) && row.plugin?.source !== 'workspace') {
      items.push({
        label: licensed(row.id) ? '查看授权' : '激活插件',
        icon: <KeyIcon className="size-3.5" />,
        onSelect: () => openLicense(row.id, row.name),
      })
    }
    if (
      row.plugin?.source !== 'workspace' &&
      row.plugin?.sourceDirectory &&
      row.plugin.state !== 'available'
    ) {
      items.push({
        label: '从本地目录重新安装',
        icon: <RefreshIcon className="size-3.5" />,
        disabled: busy !== null || !licensed(row.id),
        onSelect: () =>
          void run(
            `reinstall:${row.id}`,
            () =>
              pluginApi.installLocal(row.plugin?.sourceDirectory ?? '').then(() => {}),
            `已重新安装 ${row.name}`,
          ),
      })
    }
    if (
      row.plugin &&
      row.plugin.source !== 'workspace' &&
      row.plugin.state !== 'available'
    ) {
      if (items.length > 0) items.push({ type: 'separator' })
      items.push({
        label: '卸载',
        icon: <DeleteIcon className="size-3.5" />,
        danger: true,
        disabled: busy !== null,
        onSelect: () => setRemoving(row.plugin),
      })
    }
    return items
  }

  const columns = useMemo<DataListColumn<PluginRow>[]>(
    () => [
      {
        id: 'plugin',
        header: '插件',
        width: 'minmax(250px,1.35fr)',
        cell: (row) => (
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-control bg-bg-weak-50 text-icon-sub-600">
              <PluginNavigationIcon plugin={row.plugin} className="size-4" />
            </span>
            <span className="flex min-w-0 flex-col">
              <strong className="truncate text-ui font-medium text-text-strong-950">
                {row.name}
              </strong>
              <code className="truncate text-micro text-text-soft-400">{row.id}</code>
            </span>
          </div>
        ),
      },
      {
        id: 'capabilities',
        header: '能力',
        width: 'minmax(170px,1fr)',
        cell: (row) => (
          <span className="line-clamp-2 text-secondary text-text-sub-600">
            {capabilityText(row.capabilities)}
          </span>
        ),
      },
      {
        id: 'version',
        header: '版本',
        width: 'minmax(110px,.55fr)',
        cell: (row) => (
          <span className="flex flex-wrap items-center gap-1.5 text-secondary tabular-nums">
            v{row.version}
            {row.kind === 'installed' &&
              row.plugin?.source !== 'workspace' &&
              row.market?.state === 'update' && (
                <Badge size="small" color="information">
                  v{row.market.version}
                </Badge>
              )}
          </span>
        ),
      },
      {
        id: 'status',
        header: tab === 'installed' ? '状态' : '说明',
        width: 'minmax(210px,1.2fr)',
        cell: (row) =>
          row.kind === 'installed' && row.plugin ? (
            <div className="flex min-w-0 flex-col items-start gap-1">
              <Badge
                size="small"
                color={STATE_COLORS[row.plugin.state]}
                dot={row.plugin.state === 'running'}
              >
                {STATE_LABELS[row.plugin.state]}
              </Badge>
              {requiresPluginLicense(row.id) && row.plugin.source !== 'workspace' && (
                <span className="truncate text-micro text-text-soft-400">
                  {licenseText(licenses[row.id])}
                </span>
              )}
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <span className="line-clamp-2 text-secondary text-text-sub-600">
                {row.description}
              </span>
              {row.market && (
                <span className="shrink-0 text-micro text-text-soft-400">
                  {sizeText(row.market.size)}
                </span>
              )}
            </div>
          ),
      },
    ],
    [licenses, tab],
  )

  const noMatch = search.trim() !== '' && rows.length === 0
  const empty =
    tab === 'installed' ? (
      <EmptyState
        icon={<NavExtensionsIcon />}
        title={noMatch ? `没有匹配“${search.trim()}”的插件` : '尚未安装插件'}
        hint={
          noMatch ? undefined : '从插件商店安装插件后，它们会在这里启动并由宿主持续管理。'
        }
        actions={
          noMatch ? (
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              onClick={() => setSearch('')}
            >
              清除搜索
            </Button>
          ) : undefined
        }
      />
    ) : (
      <EmptyState
        icon={<NavExtensionsIcon />}
        title={
          noMatch
            ? `没有匹配“${search.trim()}”的插件`
            : market?.storeUrl
              ? '插件商店暂无内容'
              : '尚未配置插件商店'
        }
        hint={
          noMatch
            ? undefined
            : market?.storeUrl
              ? '当前商店没有发布可用插件。'
              : '填写商店地址后即可浏览、安装和更新插件。'
        }
        action={
          !noMatch && !market?.storeUrl
            ? { label: '配置商店', onClick: openStore }
            : undefined
        }
        actions={
          noMatch ? (
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              onClick={() => setSearch('')}
            >
              清除搜索
            </Button>
          ) : undefined
        }
      />
    )

  return (
    <>
      <PageHeader
        title="插件中心"
        count={status === 'ready' ? rows.length : undefined}
        actions={
          <>
            {tab === 'market' && updateCount > 0 && (
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                leftIcon={<DownloadIcon className="size-3.5" />}
                isLoading={busy === 'update-all'}
                disabled={busy !== null}
                onClick={() => void updateAll()}
              >
                全部更新
              </Button>
            )}
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              leftIcon={<NavSettingsIcon className="size-3.5" />}
              disabled={busy !== null}
              onClick={() => setConfigurationOpen(true)}
            >
              插件配置
            </Button>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              leftIcon={<RefreshIcon className="size-3.5" />}
              isLoading={busy === 'refresh'}
              disabled={busy !== null || !market?.storeUrl}
              onClick={() =>
                void run('refresh', async () => {
                  if (market?.storeUrl) setMarket(await pluginApi.refreshMarket())
                })
              }
            >
              检查更新
            </Button>
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              disabled={busy !== null}
              onClick={openStore}
            >
              商店设置
            </Button>
          </>
        }
      />
      <PluginWorkspace>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SegmentControl
              fit
              size="xsmall"
              semantics="tabs"
              aria-label="插件视图"
              value={tab}
              onChange={(value) => setTab(value as PluginTab)}
              items={[
                { value: 'installed', label: '已安装', count: installed.length },
                {
                  value: 'market',
                  label: '插件商店',
                  count: market?.entries.length ?? 0,
                },
              ]}
            />
            <div
              className="flex flex-wrap items-center gap-4 text-secondary text-text-sub-600"
              aria-label="插件概览"
            >
              <span>
                <strong className="font-medium tabular-nums text-text-strong-950">
                  {runningCount}
                </strong>{' '}
                运行中
              </span>
              <span>
                <strong className="font-medium tabular-nums text-text-strong-950">
                  {unlicensedCount}
                </strong>{' '}
                待激活
              </span>
              <span>
                <strong className="font-medium tabular-nums text-text-strong-950">
                  {updateCount}
                </strong>{' '}
                可更新
              </span>
              {market?.storeUrl && (
                <span className="text-text-soft-400">
                  {checkedText(market.lastCheckedAt)}
                </span>
              )}
            </div>
          </div>
          <PluginFilterRow label="插件筛选">
            <PluginSearch
              pageShortcut
              label="搜索插件"
              placeholder="插件、标识或能力"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onClear={() => setSearch('')}
            />
          </PluginFilterRow>
          {error && (
            <Alert status="error" variant="lighter" onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          {notice && (
            <Alert status="information" variant="lighter" onClose={() => setNotice(null)}>
              {notice}
            </Alert>
          )}
          {market?.lastError && tab === 'market' && (
            <Alert status="warning" variant="lighter">
              {market.lastError}
            </Alert>
          )}
          <ListColumn>
            <DataList<PluginRow>
              aria-label={tab === 'installed' ? '已安装插件' : '插件商店'}
              items={rows}
              columns={columns}
              rowHeight={58}
              getId={(row) => `${row.kind}:${row.id}`}
              getName={(row) => row.name}
              labels={{
                selectAll: '选择全部插件',
                select: (name) => `选择 ${name}`,
                more: '更多插件操作',
                actions: '操作',
              }}
              status={status}
              loading={
                <div className="flex items-center gap-2 text-body text-text-sub-600">
                  <RefreshIcon className="size-4 animate-spin" />
                  正在读取插件目录…
                </div>
              }
              error={
                <EmptyState
                  icon={<NavExtensionsIcon />}
                  title="插件目录加载失败"
                  hint={error ?? '请重试。'}
                  action={{ label: '重新加载', onClick: () => void initialize() }}
                />
              }
              empty={empty}
              rowActions={primaryAction}
              menuItems={(row) => menuItems(row)}
              onOpen={(row) => {
                if (row.plugin) setInspecting(row.plugin)
                else if (row.market) setMarketInspecting(row.market)
              }}
            />
          </ListColumn>
        </div>
      </PluginWorkspace>

      {configurationOpen && (
        <PluginConfigurationDialog onClose={() => setConfigurationOpen(false)} />
      )}

      <Modal
        open={inspecting !== null}
        onOpenChange={(open) => {
          if (!open) setInspecting(null)
        }}
        title={inspecting?.name}
        description={inspecting?.id}
        icon={<NavExtensionsIcon />}
        size="lg"
        footer={
          <Button size="xsmall" onClick={() => setInspecting(null)}>
            关闭
          </Button>
        }
      >
        {inspecting && (
          <dl className="flex flex-col">
            {[
              [
                '版本',
                `v${inspecting.version} · API ${inspecting.apiVersion} · 最低核心 ${inspecting.minCoreVersion}`,
              ],
              [
                '状态',
                `${STATE_LABELS[inspecting.state]}${inspecting.lastError ? ` · ${inspecting.lastError}` : ''}`,
              ],
              ['能力', capabilityText(inspecting.capabilities)],
              ['已授权能力', inspecting.granted.join(' · ') || '无'],
              ['方法', inspecting.methods.join(' · ') || '尚未报告'],
              ['网络域名', inspecting.permissions.networkDomains.join('、') || '未申请'],
              [
                '浏览器访问',
                inspecting.permissions.wantsBrowserAccess ? '已申请' : '未申请',
              ],
              ['私有存储', inspecting.storageDurable ? '持久化' : '不持久化'],
              ['密钥槽', inspecting.secretSlots.join('、') || '未申请'],
            ].map(([label, value]) => (
              <div
                key={label}
                className="grid grid-cols-[120px_minmax(0,1fr)] gap-4 row-line py-3 first:pt-0 last:pb-0"
              >
                <dt className="text-secondary text-text-soft-400">{label}</dt>
                <dd className="m-0 break-words text-body text-text-strong-950 [overflow-wrap:anywhere]">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Modal>

      <Modal
        open={marketInspecting !== null}
        onOpenChange={(open) => {
          if (!open) setMarketInspecting(null)
        }}
        title={marketInspecting?.name}
        description={marketInspecting?.id}
        icon={<NavExtensionsIcon />}
        size="md"
        footer={
          <Button size="xsmall" onClick={() => setMarketInspecting(null)}>
            关闭
          </Button>
        }
      >
        {marketInspecting && (
          <dl className="flex flex-col">
            {[
              [
                '版本',
                `v${marketInspecting.version} · API ${marketInspecting.apiVersion} · 最低核心 ${marketInspecting.minCoreVersion}`,
              ],
              [
                '安装状态',
                marketInspecting.state === 'current'
                  ? '已是最新版本'
                  : marketInspecting.state === 'update'
                    ? `可从 v${marketInspecting.installedVersion ?? '未知'} 更新`
                    : '尚未安装',
              ],
              ['能力', capabilityText(marketInspecting.capabilities)],
              ['大小', sizeText(marketInspecting.size)],
              ['说明', marketInspecting.description || '无'],
              ['更新内容', marketInspecting.changelog || '无'],
            ].map(([label, value]) => (
              <div
                key={label}
                className="grid grid-cols-[100px_minmax(0,1fr)] gap-4 row-line py-3 first:pt-0 last:pb-0"
              >
                <dt className="text-secondary text-text-soft-400">{label}</dt>
                <dd className="m-0 break-words text-body text-text-strong-950 [overflow-wrap:anywhere]">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Modal>

      <DialogModal
        open={licenseTarget !== null}
        onOpenChange={(open) => {
          if (!open && busy?.startsWith('license:') !== true) closeLicense()
        }}
        title={`激活 ${licenseTarget?.name ?? '插件'}`}
        subtitle={
          licenseTarget
            ? `${licenseTarget.id} · ${licenseText(licenses[licenseTarget.id])}`
            : undefined
        }
        dirty={cardDraft.trim() !== ''}
        isLoading={busy?.startsWith('license:') === true}
        isDisabled={!cardDraft.trim()}
        confirmLabel="激活"
        onConfirm={() => void activate()}
        onCancel={closeLicense}
        footerNote={licenseError}
      >
        <div className="py-inset">
          <Input
            label="插件激活码"
            placeholder="RAC-..."
            secret
            type="password"
            value={cardDraft}
            disabled={busy?.startsWith('license:') === true}
            onChange={(event) => setCardDraft(event.target.value)}
          />
        </div>
      </DialogModal>

      <DialogModal
        open={storeOpen}
        onOpenChange={(open) => {
          if (!open && busy !== 'store') setStoreOpen(false)
        }}
        title="插件商店地址"
        subtitle="填写商店根地址或 catalog.json 的完整地址，保存后会立即检查。"
        dirty={storeDraft !== (market?.storeUrl ?? '')}
        confirmLabel="保存并检查"
        isLoading={busy === 'store'}
        isDisabled={!storeDraft.trim()}
        onConfirm={() => void saveStore(storeDraft.trim())}
        onCancel={() => setStoreOpen(false)}
      >
        <div className="flex flex-col gap-3 py-inset">
          <Input
            label="商店地址"
            technical
            placeholder="https://market.example.com/raccoon-market"
            value={storeDraft}
            disabled={busy === 'store'}
            error={storeError ?? undefined}
            onChange={(event) => setStoreDraft(event.target.value)}
          />
          {market?.catalogUrl && (
            <p className="m-0 break-all text-help text-text-soft-400">
              Catalog · {market.catalogUrl}
            </p>
          )}
          {market?.storeUrl && (
            <Button
              className="self-start"
              size="xsmall"
              mode="ghost"
              variant="error"
              disabled={busy === 'store'}
              onClick={() => void saveStore(null)}
            >
              清除商店地址
            </Button>
          )}
        </div>
      </DialogModal>

      <AlertModal
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && busy?.startsWith('uninstall:') !== true) setRemoving(null)
        }}
        status="error"
        title={`卸载 ${removing?.name ?? '插件'}`}
        description="插件文件与它保存的数据都会被删除。重新使用时需要再次安装。"
        confirmLabel="卸载"
        isLoading={removing ? busy === `uninstall:${removing.id}` : false}
        onConfirm={() => {
          const plugin = removing
          if (!plugin) return
          void run(
            `uninstall:${plugin.id}`,
            () => pluginApi.uninstall(plugin.id),
            `已卸载 ${plugin.name}`,
          ).then((removed) => {
            if (removed) setRemoving(null)
          })
        }}
        onCancel={() => setRemoving(null)}
      />
    </>
  )
}
