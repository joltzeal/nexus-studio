import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AlertModal, Button, DataList, EmptyState, IconButton, Select, useLatched, type MenuItem } from '@proxyshard/shardx-ui-kit'
import { BrowserWindowSchema, type BrowserWindow } from '@nexus/contracts/browser'
import { HeaderMenu, PageHeader } from '../../../widgets/PageHeader'
import { ProxyPageLayout } from '../../../widgets/ProxyList/ProxyPageLayout'
import { ProxyToolbarLayout } from '../../../widgets/ProxyList/ProxyToolbar'
import { useProfileUi } from '../../../entities/profile'
import { useHeldLoading } from '../../../shared/hooks/useHeldLoading'
import { AddIcon, CloseIcon, CopyIcon, DeleteIcon, EditIcon, NavProxiesIcon, RefreshIcon, SearchIcon } from '../../../shared/icons'
import { useT } from '../../../shared/i18n'
import { refocusPageFilter } from '../../../shared/lib/focus'
import { toast } from '../../../shared/model/toast'
import { useNav } from '../../../shared/model/navigation'
import { BulkBarFrame } from '../../../shared/ui/BulkBarFrame'
import { FilterChips } from '../../../shared/ui/filters'
import { useListEndRoom } from '../../../shared/ui/ListColumn'
import { LoadError, LoadingRows } from '../../../shared/ui/ListStates'
import { LIST_ROW_HEIGHT } from '../../../shared/ui/listMetrics'
import { nativeApi } from '../../../raccoon/api'
import { isNativeRaccoon } from '../../../raccoon/runtime'
import { workspace } from '../../../raccoon/store'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import { proxyPoolApi } from '../../../raccoon/plugins/proxy-pool/api'
import { supportsProxyPoolPage } from '../../../raccoon/plugins/proxy-pool/page-contract'
import { PROVIDER_MANAGEMENT_METHODS } from '../../../raccoon/plugins/proxy-pool/providers'
import { activeFilterCount, EMPTY_QUERY, errorMessage, PROXY_PLUGIN_ID, type ProxyConfig, type ProxyGroup, type ProxyQuery, type ProxyRow, type Scheme } from '../../../raccoon/plugins/proxy-pool/model'
import { ProxyFormDialog } from './FormDialog'
import { ProxyBatchDialog } from './BatchDialog'
import { ProxyConfigDialog } from './ConfigDialog'
import { ProxySubscriptionDialog } from './SubscriptionDialog'
import { ProxyDetails } from './Details'
import { ProxyAssignDialog } from './AssignDialog'
import { ProvidersDialog } from './ProvidersDialog'
import { ProxyPoolFilterMenu, proxyPoolFilters } from './Filters'
import { useProxyPoolList } from './List'
import { ProxyUrlsDialog, type ProxyUrlsRequest } from './UrlsDialog'

type Progress = { done: number; ids: ReadonlySet<string> }

export function ProxyPoolPage({ onManage }: { onManage: () => void }) {
  const plugin = usePluginCatalog((state) => state.plugins.find((item) => item.id === PROXY_PLUGIN_ID))
  const native = isNativeRaccoon()
  const running = plugin?.state === 'running' && plugin.enabled
  if (!running || !supportsProxyPoolPage(plugin.methods)) {
    const heading = running
      ? '代理池接口需要更新'
      : plugin?.state === 'unlicensed' ? '代理池需要激活' : '代理池尚未就绪'
    return (
      <>
        <PageHeader title="代理池" actions={<Button size="xsmall" mode="stroke" variant="neutral" onClick={onManage}>管理插件</Button>} />
        <ProxyPageLayout
          list={<div className="list-tile flex flex-1 items-center justify-center">
            <EmptyState
              icon={<NavProxiesIcon />}
              title={heading}
              hint={plugin?.state === 'retrying' ? '宿主正在重试启动，请稍候' : plugin?.state === 'starting' ? '宿主正在启动插件' : '在插件中心检查安装、授权和版本'}
              action={{ label: '前往插件中心', onClick: onManage }}
            />
          </div>}
          peek={null}
        />
      </>
    )
  }

  return (
    <ProxyPoolInventory
      key={JSON.stringify([plugin.installation, plugin.runtimeGeneration])}
      native={native}
      canReadHistory={plugin.methods.includes('proxy.get')}
      providersAvailable={native && PROVIDER_MANAGEMENT_METHODS.every((method) => plugin.methods.includes(method))}
    />
  )
}

function ProxyPoolInventory({ native, canReadHistory, providersAvailable }: {
  native: boolean
  canReadHistory: boolean
  providersAvailable: boolean
}) {
  const t = useT()
  const [query, setQuery] = useState<ProxyQuery>(EMPTY_QUERY)
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<ProxyRow[]>([])
  const [total, setTotal] = useState(0)
  const [unfilteredTotal, setUnfilteredTotal] = useState<number | null>(null)
  const [groups, setGroups] = useState<ProxyGroup[]>([])
  const [config, setConfig] = useState<ProxyConfig | null>(null)
  const [profiles, setProfiles] = useState<BrowserWindow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [progress, setProgress] = useState<Progress | null>(null)
  const [form, setForm] = useState<{ editing: ProxyRow | null } | null>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [subscriptionsOpen, setSubscriptionsOpen] = useState(false)
  const [providerPanel, setProviderPanel] = useState<{ accountId?: string } | null>(null)
  const [opened, setOpened] = useState<ProxyRow | null>(null)
  const [assigning, setAssigning] = useState<ProxyRow | null>(null)
  const [deleting, setDeleting] = useState<string[]>([])
  const [urls, setUrls] = useState<ProxyUrlsRequest | null>(null)
  const sequence = useRef(0)
  const profileRead = useRef(0)
  const mounted = useRef(false)
  const mutation = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      sequence.current++
      profileRead.current++
    }
  }, [])

  useEffect(() => {
    if (query.keyword === search.trim()) return
    const timer = window.setTimeout(() => {
      sequence.current++
      setLoading(true)
      setSelected(new Set())
      setQuery((current) => ({ ...current, keyword: search.trim(), offset: 0 }))
    }, 250)
    return () => clearTimeout(timer)
  }, [query.keyword, search])

  const refreshProfiles = useCallback(async () => {
    if (!native) return
    const request = ++profileRead.current
    try {
      const result = BrowserWindowSchema.array().parse(await nativeApi.call('browser_window_list', { connectionId: null }))
      if (mounted.current && profileRead.current === request) setProfiles(result)
    } catch {
      if (mounted.current && profileRead.current === request) setProfiles(null)
    }
  }, [native])

  const refresh = useCallback(async () => {
    const request = ++sequence.current
    setLoading(true)
    setError(null)
    try {
      const [page, nextGroups, nextConfig] = await Promise.all([
        proxyPoolApi.list(query),
        proxyPoolApi.groups(),
        proxyPoolApi.config(),
      ])
      if (!mounted.current || request !== sequence.current) return
      if (page.offset > 0 && page.items.length === 0 && page.total <= page.offset) {
        setQuery((previous) => ({
          ...previous,
          offset: Math.max(0, Math.ceil(page.total / previous.limit) - 1) * previous.limit,
        }))
        return
      }
      setRows(page.items)
      setTotal(page.total)
      if (!activeFilterCount(query)) setUnfilteredTotal(page.total)
      setGroups(nextGroups)
      setConfig(nextConfig)
      setSelected((previous) => new Set([...previous].filter((id) => page.items.some((row) => row.id === id))))
    } catch (cause) {
      if (mounted.current && request === sequence.current) {
        const message = errorMessage(cause)
        setError(message)
        return message
      }
    } finally {
      if (mounted.current && request === sequence.current) setLoading(false)
    }
  }, [query])

  const latestRefresh = useRef(refresh)
  useEffect(() => {
    latestRefresh.current = refresh
    void refresh()
  }, [refresh])
  useEffect(() => { void refreshProfiles() }, [refreshProfiles])

  function patchQuery(patch: Partial<ProxyQuery>) {
    if (mutation.current) return
    sequence.current++
    setLoading(true)
    setSelected(new Set())
    setQuery((current) => ({ ...current, offset: 0, ...patch }))
  }

  async function saved() {
    toast.saved('代理池已保存')
    await latestRefresh.current()
  }

  async function run(action: () => Promise<void>, success: string) {
    if (mutation.current) return
    mutation.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
      toast.ok(success)
      if (mounted.current) await latestRefresh.current()
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause))
    } finally {
      mutation.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function check(candidates: readonly ProxyRow[], scheme: Scheme | null = null) {
    if (mutation.current || locked) return
    const ids = [...new Set(candidates.filter((row) => row.enabled).map((row) => row.id))]
    if (ids.length === 0) return
    if (!native) {
      toast.warn({ title: '请在桌面应用中检测代理', detail: '网页预览提供示例库存' })
      return
    }
    mutation.current = true
    setBusy(true)
    setError(null)
    const checkingIds = new Set(ids)
    setProgress({ done: 0, ids: checkingIds })
    let cursor = 0
    let done = 0
    let failed = 0
    let unconfirmed = 0
    let lastError = ''
    const worker = async () => {
      while (mounted.current && cursor < ids.length) {
        const id = ids[cursor++]
        try {
          const result = await proxyPoolApi.check(id, scheme)
          if (!result.saved) unconfirmed++
          else if (!result.ok) failed++
        } catch (cause) {
          unconfirmed++
          lastError = errorMessage(cause)
        }
        done++
        if (mounted.current) setProgress({ done, ids: checkingIds })
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker))
      if (!mounted.current) return
      const readError = await latestRefresh.current()
      if (!mounted.current) return
      const passed = done - failed - unconfirmed
      const title = `代理检测完成 · ${passed} 条通过${failed ? ` · ${failed} 条失败` : ''}${unconfirmed ? ` · ${unconfirmed} 条结果未确认` : ''}`
      if (failed || unconfirmed || readError)
        toast.warn({ title, detail: lastError || readError || (failed ? '打开代理详情查看失败原因' : '部分检测结果未保存，可重新检测') })
      else toast.ok(title)
    } finally {
      mutation.current = false
      if (mounted.current) {
        setBusy(false)
        setProgress(null)
      }
    }
  }

  const locked = busy || loading || search.trim() !== query.keyword
  const selectedRows = rows.filter((row) => selected.has(row.id))
  const selectedIds = selectedRows.map((row) => row.id)
  const canDeleteSelection = selectedRows.every((row) => !row.origin)
  const batchRows = selected.size > 0 ? selectedRows : rows
  const canCheckBatch = batchRows.some((row) => row.enabled)
  const shownSelection = useLatched(selectedIds.length > 0 ? selectedIds.length : null)
  const bottomInset = useListEndRoom(selectedIds.length > 0)
  const firstLoad = useHeldLoading(loading && config === null)
  const empty = !loading && !error && total === 0 && activeFilterCount(query) === 0 && !search.trim()
  const activeRow = rows.find((row) => row.id === opened?.id) ?? opened
  const defaultId = config?.defaultEndpointId ?? null
  const profileLinks = useMemo(() => {
    if (!profiles) return null
    const byEndpoint = new Map<string, { id: string; name: string; connectionId: string; followsDefault: boolean }[]>()
    for (const profile of profiles) {
      if (profile.proxyMode !== 'plugin' || profile.proxyPlugin !== PROXY_PLUGIN_ID) continue
      const endpoint = profile.proxyEndpoint === null ? defaultId : String(profile.proxyEndpoint)
      if (!endpoint) continue
      const link = { id: profile.id, name: profile.name, connectionId: profile.connectionId, followsDefault: profile.proxyEndpoint === null }
      const using = byEndpoint.get(endpoint)
      if (using) using.push(link)
      else byEndpoint.set(endpoint, [link])
    }
    return byEndpoint
  }, [defaultId, profiles])
  const profileCounts = useMemo(() => profileLinks && new Map([...profileLinks].map(([id, list]) => [id, list.length])), [profileLinks])
  const groupName = useCallback((row: ProxyRow) => row.origin
    ? '服务商订阅'
    : row.groupId === null ? '未分组' : groups.find((group) => String(group.id) === row.groupId)?.name ?? '分组未知', [groups])
  const list = useProxyPoolList({ rows, defaultId, groupName, profileCounts, checking: progress?.ids })
  const { fields, chips } = proxyPoolFilters(query, groups, patchQuery)

  function edit(row: ProxyRow) {
    if (row.origin) {
      if (providersAvailable) setProviderPanel({ accountId: row.origin.accountId })
    } else setForm({ editing: row })
  }

  function focusList(id?: string) {
    requestAnimationFrame(() => {
      const target = id ? list.layout.scrollRef.current?.querySelector<HTMLElement>(`[data-row-id="${id}"]`) : null
      if (target) target.focus({ preventScroll: true })
      else list.layout.scrollRef.current?.querySelector<HTMLElement>('[data-row-id][tabindex="0"]')?.focus({ preventScroll: true })
    })
  }

  function rowMenu(row: ProxyRow): MenuItem[] {
    return [
      {
        label: row.origin ? '管理服务商订阅' : '编辑代理',
        icon: <EditIcon className="size-3.5" />,
        disabled: locked || (!!row.origin && !providersAvailable),
        onSelect: () => edit(row),
      },
      ...(native ? [{ label: '分配给 Profile', disabled: locked || !row.enabled, onSelect: () => setAssigning(row) }] : []),
      ...row.schemes.map((scheme) => ({
        label: `检测 ${scheme.toUpperCase()}`,
        disabled: locked || !row.enabled,
        onSelect: () => { void check([row], scheme) },
      })),
      {
        label: '复制代理 URL',
        icon: <CopyIcon className="size-3.5" />,
        disabled: locked,
        onSelect: () => setUrls({ ids: [row.id], scheme: row.schemes.length === 1 ? row.schemes[0] : null }),
      },
      {
        label: '设为默认代理',
        disabled: locked || !row.enabled || !config || defaultId === row.id,
        onSelect: () => {
          if (config) void run(async () => {
            await proxyPoolApi.saveConfig({
              defaultEndpointId: row.id,
              riskEnabled: config.risk.enabled,
              riskCacheSeconds: config.risk.cacheSeconds,
            })
          }, '默认代理已保存')
        },
      },
      { type: 'separator' },
      {
        label: '删除代理',
        icon: <DeleteIcon className="size-3.5" />,
        danger: true,
        disabled: locked || !!row.origin,
        onSelect: () => setDeleting([row.id]),
      },
    ]
  }

  const noRows = inventoryEmptyState({
    query,
    clearSearch: () => { setSearch(''); refocusPageFilter() },
    clearFilters: () => patchQuery({ ...EMPTY_QUERY, keyword: query.keyword, limit: query.limit }),
    add: () => setForm({ editing: null }),
  })

  return (
    <>
      <PageHeader
        title="代理池"
        count={firstLoad || empty ? undefined : activeFilterCount(query) && unfilteredTotal !== null && total <= unfilteredTotal ? { shown: total, total: unfilteredTotal } : total}
        filter={empty ? undefined : { value: search, onChange: setSearch, placeholder: '名称或主机' }}
        actions={
          <ProxyToolbarLayout>
            {!empty && <ProxyPoolFilterMenu fields={fields} count={chips.length} query={query} disabled={busy} onChange={patchQuery} />}
            {!empty && list.display}
            {!empty && (
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={locked || !canCheckBatch}
                isLoading={progress !== null}
                aria-description={selected.size > 0 ? '检测选中的启用代理' : '检测当前页的启用代理'}
                leftIcon={<RefreshIcon className="size-3.5" />}
                onClick={() => { void check(batchRows) }}
              >
                批量检测
              </Button>
            )}
            <HeaderMenu
              label="代理池选项"
              items={[
                { label: '刷新', icon: <RefreshIcon className="size-3.5" />, disabled: locked, onSelect: () => { void refresh(); void refreshProfiles() } },
                ...(native ? [{ label: providersAvailable ? '代理服务商' : '代理服务商（需更新插件）', disabled: locked || !providersAvailable, onSelect: () => setProviderPanel({}) }] : []),
                { label: '批量添加', disabled: locked, onSelect: () => setBatchOpen(true) },
                { label: 'Clash 订阅', disabled: locked, onSelect: () => setSubscriptionsOpen(true) },
                { label: '配置', disabled: locked || !config, onSelect: () => setConfigOpen(true) },
              ]}
            />
            <Button size="xsmall" mode="filled" variant="primary" leftIcon={<AddIcon className="size-3.5" />} disabled={locked} onClick={() => setForm({ editing: null })}>添加代理</Button>
          </ProxyToolbarLayout>
        }
      />
      <ProxyPageLayout
        filters={<FilterChips chips={chips} onClear={() => patchQuery({ ...EMPTY_QUERY, keyword: query.keyword, limit: query.limit })} />}
        notice={
          <>
            {!native && <p className="m-0 mb-2 text-secondary text-text-soft-400">网页预览 · 示例库存仅用于界面演示</p>}
            {progress && <p role="status" className="m-0 mb-2 text-secondary tabular-nums text-text-sub-600">正在检测 {progress.done} / {progress.ids.size}</p>}
            {error && rows.length > 0 && <Alert status="error" variant="lighter" className="mb-2" onClose={() => setError(null)}>{error}</Alert>}
          </>
        }
        list={
          <>
            <BulkBarFrame open={selectedIds.length > 0} label={t('bulkActionsBar.selectedCount', { n: shownSelection ?? 0 })} onClosedWithFocus={() => focusList()}>
              {(narrow) => (
                <>
                  <span className="mr-1.5 text-secondary font-medium text-text-strong-950 tabular-nums">{t('bulkActionsBar.selectedCount', { n: shownSelection ?? 0 })}</span>
                  <BulkAction label="检测选中" icon={<RefreshIcon className="size-3.5" />} narrow={narrow} disabled={locked || !canCheckBatch} onClick={() => { void check(selectedRows) }} />
                  <BulkAction label="复制 URL" icon={<CopyIcon className="size-3.5" />} narrow={narrow} disabled={locked} onClick={() => setUrls({ ids: selectedIds, scheme: null })} />
                  <BulkAction label="加入订阅" icon={<AddIcon className="size-3.5" />} narrow={narrow} disabled={locked} onClick={() => setSubscriptionsOpen(true)} />
                  <BulkAction label={canDeleteSelection ? '删除' : '服务商代理请从对应订阅中删除'} icon={<DeleteIcon className="size-3.5" />} narrow={narrow} danger disabled={locked || !canDeleteSelection} onClick={() => setDeleting(selectedIds)} />
                  <IconButton label="取消选择" icon={<CloseIcon className="size-3.5" />} size="3xsmall" onClick={() => setSelected(new Set())} />
                </>
              )}
            </BulkBarFrame>
            <DataList
              aria-label="代理池库存"
              items={list.items}
              columns={list.columns}
              layout={list.layout}
              getId={({ proxy }) => proxy.id}
              getName={({ proxy }) => proxy.name}
              rowHeight={LIST_ROW_HEIGHT}
              status={firstLoad ? 'loading' : error && rows.length === 0 ? 'error' : 'ready'}
              loading={<LoadingRows inGrid />}
              error={<LoadError what="代理库存" error={error} onRetry={() => { void refresh() }} />}
              empty={noRows}
              selected={selected}
              currentId={activeRow?.id}
              bottomInset={bottomInset}
              onSelectedChange={(next) => { if (!locked) setSelected(next) }}
              onOpen={({ proxy }) => setOpened(proxy)}
              openOnClick
              onDelete={(ids) => {
                if (!locked && ids.every((id) => rows.some((row) => row.id === id && !row.origin))) setDeleting(ids)
              }}
              menuItems={({ proxy }) => [{ label: '连接详情', onSelect: () => setOpened(proxy) }, ...rowMenu(proxy)]}
              labels={{
                selectAll: '选择当前页',
                select: (name) => t('proxyList.select', { name }),
                more: t('profileRowActions.moreActions'),
                actions: t('proxyList.colActions'),
                selectedCount: (n) => t('bulkActionsBar.selectedCount', { n }),
                selectionCleared: '已取消选择',
              }}
            />
          </>
        }
        footer={config && total > 0 && <ProxyPagination query={query} total={total} locked={locked} onChange={patchQuery} />}
        peek={
          <ProxyDetails
            row={activeRow}
            inventory={rows}
            canReadHistory={canReadHistory}
            groupName={groupName}
            checking={!!activeRow && (progress?.ids.has(activeRow.id) ?? false)}
            locked={locked}
            canEdit={(row) => !row.origin || providersAvailable}
            profiles={profileLinks && activeRow ? profileLinks.get(activeRow.id) ?? [] : null}
            onSelectProfile={(id) => {
              const link = activeRow && profileLinks?.get(activeRow.id)?.find((item) => item.id === id)
              if (!link) return
              void workspace.select(link.connectionId).then(async () => {
                await useNav.getState().setSection('profiles')
                await useProfileUi.getState().showInList(id)
              }).catch((cause) => toast.fail({ title: 'Profile 加载失败', detail: cause }))
            }}
            menuItems={rowMenu}
            onClose={() => { setOpened(null); focusList(activeRow?.id) }}
            onEdit={edit}
            onCheck={(row) => { void check([row]) }}
          />
        }
      />
      {form && <ProxyFormDialog editing={form.editing} groups={groups} onClose={() => setForm(null)} onSaved={saved} />}
      {batchOpen && <ProxyBatchDialog groups={groups} onClose={() => setBatchOpen(false)} onSaved={saved} />}
      {configOpen && config && <ProxyConfigDialog config={config} onClose={() => setConfigOpen(false)} onSaved={saved} />}
      {subscriptionsOpen && <ProxySubscriptionDialog groups={groups} selectedIds={selectedIds} onClose={() => setSubscriptionsOpen(false)} />}
      {providerPanel && providersAvailable && <ProvidersDialog initialAccountId={providerPanel.accountId} onClose={() => setProviderPanel(null)} onInventoryChanged={() => { void latestRefresh.current() }} />}
      {assigning && <ProxyAssignDialog row={assigning} onClose={() => { setAssigning(null); void refreshProfiles() }} />}
      {urls && <ProxyUrlsDialog request={urls} onClose={() => setUrls(null)} />}
      <AlertModal
        open={deleting.length > 0}
        status="error"
        title={`删除 ${deleting.length} 条代理`}
        description="代理记录及密码会从插件库存移除。已引用这些端点的 Profile 需要重新选择代理"
        confirmLabel="删除代理"
        isLoading={busy}
        onOpenChange={(open) => { if (!open && !busy) setDeleting([]) }}
        onConfirm={() => {
          void run(async () => {
            await proxyPoolApi.remove(deleting)
            if (opened && deleting.includes(opened.id)) setOpened(null)
            setDeleting([])
            setSelected(new Set())
          }, '代理已删除')
        }}
      />
    </>
  )
}

function BulkAction({ label, icon, narrow, disabled, danger, onClick }: {
  label: string
  icon: React.ReactNode
  narrow: boolean
  disabled: boolean
  danger?: boolean
  onClick: () => void
}) {
  const variant = danger ? 'error' : 'neutral'
  return narrow
    ? <IconButton label={label} icon={icon} size="3xsmall" variant={variant} mode="ghost" disabled={disabled} onClick={onClick} />
    : <Button size="3xsmall" variant={variant} mode="ghost" leftIcon={icon} disabled={disabled} onClick={onClick}>{danger ? '删除' : label}</Button>
}

function ProxyPagination({ query, total, locked, onChange }: {
  query: ProxyQuery
  total: number
  locked: boolean
  onChange: (patch: Partial<ProxyQuery>) => void
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-secondary text-text-sub-600">
      <span className="tabular-nums">共 {total} 条 · 第 {Math.floor(query.offset / query.limit) + 1} / {Math.max(1, Math.ceil(total / query.limit))} 页</span>
      <div className="flex items-center gap-2">
        <div className="w-28">
          <Select
            aria-label="每页条数"
            size="xsmall"
            disabled={locked}
            value={String(query.limit)}
            onChange={(value) => onChange({ limit: Number(value) })}
            options={[10, 50, 100, 200, 500].map((size) => ({ value: String(size), label: `每页 ${size} 条` }))}
          />
        </div>
        <Button size="xsmall" mode="stroke" variant="neutral" disabled={locked || query.offset === 0} onClick={() => onChange({ offset: query.offset - query.limit })}>上一页</Button>
        <Button size="xsmall" mode="stroke" variant="neutral" disabled={locked || query.offset + query.limit >= total} onClick={() => onChange({ offset: query.offset + query.limit })}>下一页</Button>
      </div>
    </div>
  )
}

function inventoryEmptyState({ query, clearSearch, clearFilters, add }: {
  query: ProxyQuery
  clearSearch: () => void
  clearFilters: () => void
  add: () => void
}) {
  if (query.keyword) return <EmptyState icon={<SearchIcon />} title={`未找到“${query.keyword}”`} action={{ label: '清除搜索', onClick: clearSearch }} />
  if (activeFilterCount(query)) return <EmptyState icon={<NavProxiesIcon />} title="没有符合条件的代理" action={{ label: '清除筛选', onClick: clearFilters }} />
  return <EmptyState icon={<NavProxiesIcon />} title="尚未添加代理" action={{ label: '新增代理', icon: <AddIcon />, onClick: add }} />
}
