import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  AlertModal,
  Button,
  Checkbox,
  DataList,
  EmptyState,
  Input,
  Modal,
  Select,
  Textarea,
  type DataListColumn,
  type MenuItem,
} from '@proxyshard/shardx-ui-kit'
import { HeaderMenu, PageHeader } from '../../../widgets/PageHeader'
import { MorePluginFilters, PluginFilterRow, PluginSearch } from '../PluginFilterRow'
import { PluginWorkspace } from '../PluginWorkspace'
import { ListColumn } from '../../../shared/ui/ListColumn'
import {
  AddIcon,
  CopyIcon,
  DeleteIcon,
  EditIcon,
  NavProxiesIcon,
  RefreshIcon,
} from '../../../shared/icons'
import { clip } from '../../../shared/lib/clipboard'
import { toast } from '../../../shared/model/toast'
import { isNativeRaccoon } from '../../../raccoon/runtime'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import { proxyPoolApi } from '../../../raccoon/plugins/proxy-pool/api'
import { supportsProxyPoolPage } from '../../../raccoon/plugins/proxy-pool/page-contract'
import { PROVIDER_MANAGEMENT_METHODS } from '../../../raccoon/plugins/proxy-pool/providers'
import {
  activeFilterCount,
  addressOf,
  EMPTY_QUERY,
  errorMessage,
  PROXY_PLUGIN_ID,
  SCHEMES,
  type ProxyConfig,
  type ProxyGroup,
  type ProxyQuery,
  type ProxyRow,
  type Scheme,
} from '../../../raccoon/plugins/proxy-pool/model'
import { ProxyFormDialog } from './FormDialog'
import { ProxyBatchDialog } from './BatchDialog'
import { ProxyConfigDialog } from './ConfigDialog'
import { ProxySubscriptionDialog } from './SubscriptionDialog'
import { ProxyDetails } from './Details'
import { ProxyAssignDialog } from './AssignDialog'
import { ProvidersDialog } from './ProvidersDialog'

type ColumnId =
  | 'name'
  | 'address'
  | 'username'
  | 'group'
  | 'protocol'
  | 'status'
  | 'exit'
  | 'risk'
  | 'password'
const OPTIONAL_COLUMNS: { id: ColumnId; label: string }[] = [
  { id: 'username', label: '用户名' },
  { id: 'group', label: '分组' },
  { id: 'protocol', label: '协议' },
  { id: 'status', label: '状态' },
  { id: 'exit', label: '出口与延迟' },
  { id: 'risk', label: 'IP 风险' },
  { id: 'password', label: '密码' },
]
function RiskValue({ row }: { row: ProxyRow }) {
  const reputation = row.reputation
  if (!reputation) return <span className="text-text-soft-400">未检测</span>
  if (reputation.status !== 'ok') {
    const labels: Record<string, string> = {
      disabled: '检测已关闭',
      unavailable: '查询失败',
      rate_limited: '查询限流',
      non_public: '非公网 IP',
    }
    return (
      <span className="text-text-soft-400">{labels[reputation.status] ?? '未知'}</span>
    )
  }
  return (
    <span className="flex flex-col gap-1">
      <span
        className={
          reputation.risk !== null && reputation.risk >= 66
            ? 'tabular-nums text-error-text'
            : 'tabular-nums text-text-sub-600'
        }
      >
        {reputation.risk === null ? '风险未知' : `${reputation.risk} / 100`}
      </span>
      <span className="truncate text-micro text-text-soft-400">
        {row.geo?.country || reputation.networkType || '属地未知'}
      </span>
    </span>
  )
}

export function ProxyPoolPage({ onManage }: { onManage: () => void }) {
  const plugin = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === PROXY_PLUGIN_ID),
  )
  const running = plugin?.state === 'running' && plugin.enabled
  const compatible = running && supportsProxyPoolPage(plugin.methods)
  const providersAvailable =
    compatible &&
    isNativeRaccoon() &&
    PROVIDER_MANAGEMENT_METHODS.every((method) => plugin.methods.includes(method))
  const [query, setQuery] = useState<ProxyQuery>({ ...EMPTY_QUERY })
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<ProxyRow[]>([])
  const [total, setTotal] = useState(0)
  const [groups, setGroups] = useState<ProxyGroup[]>([])
  const [config, setConfig] = useState<ProxyConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnId>>(
    new Set([
      'name',
      'address',
      'username',
      'group',
      'protocol',
      'status',
      'exit',
      'risk',
    ]),
  )
  const [sort, setSort] = useState({ key: 'name', descending: false })
  const [form, setForm] = useState<{ editing: ProxyRow | null } | null>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [subscriptionsOpen, setSubscriptionsOpen] = useState(false)
  const [providerPanel, setProviderPanel] = useState<{ accountId?: string } | null>(null)
  const [details, setDetails] = useState<ProxyRow | null>(null)
  const [assigning, setAssigning] = useState<ProxyRow | null>(null)
  const [deleting, setDeleting] = useState<string[]>([])
  const [urls, setUrls] = useState<{ ids: string[]; scheme: Scheme | null } | null>(null)
  const sequence = useRef(0)
  const mounted = useRef(true)
  const mutation = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      sequence.current++
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery((current) =>
        current.keyword === search.trim()
          ? current
          : { ...current, keyword: search.trim(), offset: 0 },
      )
      setSelected(new Set())
    }, 250)
    return () => clearTimeout(timer)
  }, [search])

  const refresh = useCallback(async () => {
    if (!compatible) return
    const current = ++sequence.current
    setLoading(true)
    setError(null)
    try {
      const [page, nextGroups, nextConfig] = await Promise.all([
        proxyPoolApi.list(query),
        proxyPoolApi.groups(),
        proxyPoolApi.config(),
      ])
      if (!mounted.current || current !== sequence.current) return
      if (page.offset > 0 && page.items.length === 0 && page.total <= page.offset) {
        setQuery((previous) => ({
          ...previous,
          offset:
            Math.max(0, Math.ceil(page.total / previous.limit) - 1) * previous.limit,
        }))
        return
      }
      setRows(page.items)
      setTotal(page.total)
      setGroups(nextGroups)
      setConfig(nextConfig)
      setSelected(
        (previous) =>
          new Set([...previous].filter((id) => page.items.some((row) => row.id === id))),
      )
    } catch (cause) {
      if (mounted.current && current === sequence.current) setError(errorMessage(cause))
    } finally {
      if (mounted.current && current === sequence.current) setLoading(false)
    }
  }, [compatible, query])

  const latestRefresh = useRef(refresh)
  useEffect(() => {
    latestRefresh.current = refresh
  }, [refresh])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function patchQuery(patch: Partial<ProxyQuery>) {
    sequence.current++
    setLoading(true)
    setSelected(new Set())
    setQuery((current) => ({ ...current, offset: 0, ...patch }))
  }

  async function saved() {
    toast.saved('代理池已保存')
    await refresh()
  }

  async function run(action: () => Promise<void>, success?: string) {
    if (mutation.current) return
    mutation.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
      if (success) toast.ok(success)
      if (mounted.current) await latestRefresh.current()
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause))
    } finally {
      mutation.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function check(ids: string[], scheme: Scheme | null = null) {
    if (mutation.current || ids.length === 0) return
    mutation.current = true
    setBusy(true)
    setError(null)
    setProgress({ done: 0, total: ids.length })
    let cursor = 0
    let done = 0
    let failed = 0
    const worker = async () => {
      while (mounted.current && cursor < ids.length) {
        const id = ids[cursor++]
        try {
          const result = await proxyPoolApi.check(id, scheme)
          if (!result.ok || !result.saved) failed++
        } catch {
          failed++
        }
        done++
        if (mounted.current) setProgress({ done, total: ids.length })
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker))
    mutation.current = false
    if (!mounted.current) return
    setBusy(false)
    setProgress(null)
    if (failed > 0)
      toast.warn({
        title: `已检测 ${done} 条代理，${failed} 条未通过`,
        detail: '可在连接详情中查看检测原因',
      })
    else toast.ok(`已检测 ${done} 条代理`)
    await latestRefresh.current()
  }

  const locked = busy || loading || search.trim() !== query.keyword
  const selectedIds = rows.filter((row) => selected.has(row.id)).map((row) => row.id)
  const hasProviderSelection = rows.some((row) => selected.has(row.id) && row.origin)
  const orderedRows = useMemo(
    () =>
      [...rows].sort((left, right) => {
        let comparison: number
        if (sort.key === 'risk')
          comparison = (left.reputation?.risk ?? 101) - (right.reputation?.risk ?? 101)
        else if (sort.key === 'latency')
          comparison =
            (left.latencyMs ?? Number.MAX_SAFE_INTEGER) -
            (right.latencyMs ?? Number.MAX_SAFE_INTEGER)
        else {
          const field = sort.key as 'name' | 'host' | 'username'
          comparison = left[field].localeCompare(right[field])
        }
        return sort.descending ? -comparison : comparison
      }),
    [rows, sort],
  )
  const groupName = (row: ProxyRow) =>
    row.origin
      ? '服务商订阅'
      : row.groupId === null
        ? '未分组'
        : (groups.find((group) => String(group.id) === row.groupId)?.name ?? '分组未知')
  const columns: DataListColumn<ProxyRow>[] = [
    {
      id: 'name',
      header: '名称',
      width: 'minmax(128px,1fr)',
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium">{row.name}</span>
          {config?.defaultEndpointId === row.id && (
            <span className="text-micro text-primary-text">默认代理</span>
          )}
        </span>
      ),
    },
    {
      id: 'address',
      header: '连接地址',
      width: 'minmax(156px,1.25fr)',
      cell: (row) => (
        <code className="block w-full overflow-hidden text-ellipsis whitespace-nowrap text-mono text-text-sub-600">
          {addressOf(row)}
        </code>
      ),
    },
    {
      id: 'username',
      header: '用户名',
      width: 'minmax(100px,.9fr)',
      cell: (row) => (
        <Button
          size="3xsmall"
          mode="ghost"
          variant="neutral"
          className="w-full min-w-0 max-w-full overflow-hidden"
          contentAlign="start"
          onClick={() => setDetails(row)}
        >
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            {row.username || '未设置'}
          </span>
        </Button>
      ),
    },
    {
      id: 'group',
      header: '分组',
      width: 'minmax(72px,.6fr)',
      cell: (row) => (
        <span className="block truncate text-secondary text-text-sub-600">
          {groupName(row)}
        </span>
      ),
    },
    {
      id: 'protocol',
      header: '协议',
      width: '112px',
      cell: (row) => (
        <span className="block truncate text-mono text-text-sub-600">
          {row.schemes.map((scheme) => scheme.toUpperCase()).join(' / ')}
        </span>
      ),
    },
    {
      id: 'status',
      header: '状态',
      width: '80px',
      cell: (row) => (
        <span className="flex items-center gap-2 text-secondary text-text-sub-600">
          <span
            className={`size-1.5 shrink-0 rounded-full ${row.enabled ? 'bg-success-base' : 'bg-text-soft-400'}`}
          />
          {row.enabled ? '启用' : '停用'}
        </span>
      ),
    },
    {
      id: 'exit',
      header: '出口 / 延迟',
      width: 'minmax(128px,1fr)',
      cell: (row) => (
        <span className="flex flex-col gap-1">
          <code className="truncate text-mono text-text-sub-600">
            {row.exitIp || (row.checkStatus === 'failed' ? '检测失败' : '未检测')}
          </code>
          <span
            className={`text-micro tabular-nums ${row.checkStatus === 'failed' ? 'text-error-text' : 'text-text-soft-400'}`}
          >
            {row.checkStatus === 'failed'
              ? '查看连接详情'
              : row.latencyMs === null
                ? '—'
                : `${row.latencyMs} ms`}
            {row.exitIpChanged ? ' · IP 已变化' : ''}
          </span>
        </span>
      ),
    },
    {
      id: 'risk',
      header: 'IP 风险',
      width: '104px',
      cell: (row) => <RiskValue row={row} />,
    },
    {
      id: 'password',
      header: '密码',
      width: '80px',
      cell: (row) => (
        <span className="text-secondary text-text-sub-600">
          {row.hasPassword ? '已配置' : '未配置'}
        </span>
      ),
    },
  ]

  function rowMenu(row: ProxyRow): MenuItem[] {
    return [
      { label: '连接详情', onSelect: () => setDetails(row) },
      {
        label: row.origin ? '管理服务商订阅' : '编辑代理',
        icon: <EditIcon className="size-3.5" />,
        disabled: locked || (!!row.origin && !providersAvailable),
        onSelect: () => {
          if (row.origin) setProviderPanel({ accountId: row.origin.accountId })
          else setForm({ editing: row })
        },
      },
      ...(isNativeRaccoon()
        ? [
            {
              label: '分配给 Profile',
              disabled: locked || !row.enabled,
              onSelect: () => setAssigning(row),
            },
          ]
        : []),
      ...row.schemes.map((scheme) => ({
        label: `检测 ${scheme.toUpperCase()}`,
        disabled: locked || !row.enabled,
        onSelect: () => {
          void check([row.id], scheme)
        },
      })),
      {
        label: '复制代理 URL',
        icon: <CopyIcon className="size-3.5" />,
        disabled: locked,
        onSelect: () =>
          setUrls({
            ids: [row.id],
            scheme: row.schemes.length === 1 ? row.schemes[0] : null,
          }),
      },
      {
        label: '设为默认代理',
        disabled:
          locked || !row.enabled || !config || config.defaultEndpointId === row.id,
        onSelect: () => {
          if (config)
            void run(async () => {
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

  if (!compatible) {
    const heading = !running
      ? plugin?.state === 'unlicensed'
        ? '代理池需要激活'
        : '代理池尚未就绪'
      : '代理池接口需要更新'
    return (
      <>
        <PageHeader
          title="代理池"
          actions={
            <Button size="xsmall" mode="stroke" variant="neutral" onClick={onManage}>
              管理插件
            </Button>
          }
        />
        <PluginWorkspace>
          <EmptyState
            icon={<NavProxiesIcon />}
            title={heading}
            hint={
              plugin?.state === 'retrying'
                ? '宿主正在重试启动，请稍候'
                : plugin?.state === 'starting'
                  ? '宿主正在启动插件'
                  : '在插件中心检查安装、授权和版本'
            }
            action={{ label: '前往插件中心', onClick: onManage }}
          />
        </PluginWorkspace>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="代理池"
        count={loading ? undefined : total}
        actions={
          <>
            {isNativeRaccoon() && (
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                aria-label={
                  providersAvailable ? '代理服务商' : '代理服务商（需更新插件）'
                }
                disabled={busy || !providersAvailable}
                onClick={() => setProviderPanel({})}
              >
                {providersAvailable ? '代理服务商' : '代理服务商（需更新插件）'}
              </Button>
            )}
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              disabled={locked}
              onClick={() => {
                void refresh()
              }}
              leftIcon={<RefreshIcon className="size-3.5" />}
            >
              刷新
            </Button>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              disabled={locked}
              onClick={() => setBatchOpen(true)}
            >
              批量添加
            </Button>
            <Button
              size="xsmall"
              disabled={locked}
              onClick={() => setForm({ editing: null })}
              leftIcon={<AddIcon className="size-3.5" />}
            >
              新增代理
            </Button>
            <HeaderMenu
              label="代理池选项"
              items={[
                { label: '显示列', onSelect: () => setColumnsOpen(true) },
                {
                  label: 'Clash 订阅',
                  disabled: locked,
                  onSelect: () => setSubscriptionsOpen(true),
                },
                {
                  label: '配置',
                  disabled: locked || !config,
                  onSelect: () => setConfigOpen(true),
                },
              ]}
            />
          </>
        }
      />
      <PluginWorkspace>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {!isNativeRaccoon() && (
            <p className="text-secondary text-text-soft-400">
              网页预览 · 示例库存仅用于界面演示
            </p>
          )}
          <PluginFilterRow label="代理筛选">
            <PluginSearch
              pageShortcut
              label="搜索代理"
              placeholder="名称或主机"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onClear={() => setSearch('')}
            />
            <ProxyFilters
              query={query}
              groups={groups}
              disabled={busy}
              onChange={patchQuery}
              onReset={() => {
                setSearch('')
                patchQuery({ ...EMPTY_QUERY, limit: query.limit })
              }}
            />
            <div className="w-[104px]">
              <Select
                label="当前页排序"
                size="xsmall"
                value={`${sort.key}:${sort.descending ? 'desc' : 'asc'}`}
                onChange={(value) => {
                  const [key, direction] = value.split(':')
                  setSort({ key, descending: direction === 'desc' })
                }}
                options={[
                  ['name', '名称'],
                  ['host', '主机'],
                  ['username', '用户名'],
                  ['risk', 'IP 风险'],
                  ['latency', '延迟'],
                ].flatMap(([key, label]) => [
                  { value: `${key}:asc`, label: `${label} ↑`, hint: '升序' },
                  { value: `${key}:desc`, label: `${label} ↓`, hint: '降序' },
                ])}
              />
            </div>
          </PluginFilterRow>
          {error && (
            <Alert status="error" variant="lighter" onClose={() => setError(null)}>
              {error}
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                disabled={busy}
                onClick={() => {
                  void refresh()
                }}
              >
                重新读取
              </Button>
            </Alert>
          )}
          {progress && (
            <p role="status" className="text-secondary tabular-nums text-text-sub-600">
              正在检测 {progress.done} / {progress.total}
            </p>
          )}
          {selectedIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-control bg-bg-weak-50 px-3 py-2">
              <span className="mr-2 text-secondary tabular-nums text-text-sub-600">
                已选 {selectedIds.length} 条
              </span>
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={locked}
                onClick={() => {
                  void check(selectedIds)
                }}
              >
                检测选中
              </Button>
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                disabled={locked}
                onClick={() => setUrls({ ids: selectedIds, scheme: null })}
              >
                复制 URL
              </Button>
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                disabled={locked}
                onClick={() => setSubscriptionsOpen(true)}
              >
                加入订阅
              </Button>
              <Button
                size="xsmall"
                mode="ghost"
                variant="error"
                disabled={locked || hasProviderSelection}
                onClick={() => setDeleting(selectedIds)}
              >
                删除
              </Button>
              {hasProviderSelection && (
                <span className="text-secondary text-text-sub-600">
                  服务商代理请从对应订阅中删除
                </span>
              )}
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                disabled={busy}
                onClick={() => setSelected(new Set())}
              >
                取消选择
              </Button>
            </div>
          )}
          <ListColumn className="[&_[role=treegrid]]:min-w-[1080px]">
            <DataList<ProxyRow>
              aria-label="代理池库存"
              items={orderedRows}
              columns={columns.filter((column) =>
                visibleColumns.has(column.id as ColumnId),
              )}
              getId={(row) => row.id}
              getName={(row) => row.name}
              rowHeight={58}
              status={loading ? 'loading' : 'ready'}
              selected={selected}
              onSelectedChange={(next) => {
                if (!locked) setSelected(next)
              }}
              onOpen={setDetails}
              openOnClick
              onDelete={(ids) => {
                if (!locked) setDeleting(ids)
              }}
              menuItems={rowMenu}
              labels={{
                selectAll: '选择当前页',
                select: (name) => `选择 ${name}`,
                more: '代理操作',
                actions: '操作',
              }}
              loading={
                <p className="p-4 text-secondary text-text-sub-600">正在读取代理库存</p>
              }
              empty={
                <EmptyState
                  icon={<NavProxiesIcon />}
                  title={
                    error
                      ? '代理库存读取失败'
                      : activeFilterCount(query)
                        ? '没有符合条件的代理'
                        : '尚未添加代理'
                  }
                  hint={
                    error
                      ? '请重新读取代理库存'
                      : '可单条添加、批量导入代理 URL 或添加代理服务商'
                  }
                  action={{
                    label: error ? '重新读取' : '新增代理',
                    onClick: () => {
                      if (error) void refresh()
                      else setForm({ editing: null })
                    },
                  }}
                />
              }
            />
          </ListColumn>
          <div className="flex flex-wrap items-center justify-between gap-3 text-secondary text-text-sub-600">
            <span className="tabular-nums">
              共 {total} 条 · 第 {Math.floor(query.offset / query.limit) + 1} /{' '}
              {Math.max(1, Math.ceil(total / query.limit))} 页
            </span>
            <div className="flex items-center gap-2">
              <div className="w-28">
                <Select
                  aria-label="每页条数"
                  size="xsmall"
                  disabled={locked}
                  value={String(query.limit)}
                  onChange={(value) => patchQuery({ limit: Number(value) })}
                  options={[10, 50, 100, 200, 500].map((size) => ({
                    value: String(size),
                    label: `每页 ${size} 条`,
                  }))}
                />
              </div>
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={locked || query.offset === 0}
                onClick={() => patchQuery({ offset: query.offset - query.limit })}
              >
                上一页
              </Button>
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={locked || query.offset + query.limit >= total}
                onClick={() => patchQuery({ offset: query.offset + query.limit })}
              >
                下一页
              </Button>
            </div>
          </div>
        </div>
      </PluginWorkspace>
      {form && (
        <ProxyFormDialog
          editing={form.editing}
          groups={groups}
          onClose={() => setForm(null)}
          onSaved={saved}
        />
      )}
      {batchOpen && (
        <ProxyBatchDialog
          groups={groups}
          onClose={() => setBatchOpen(false)}
          onSaved={saved}
        />
      )}
      {configOpen && config && (
        <ProxyConfigDialog
          config={config}
          onClose={() => setConfigOpen(false)}
          onSaved={saved}
        />
      )}
      {subscriptionsOpen && (
        <ProxySubscriptionDialog
          groups={groups}
          selectedIds={selectedIds}
          onClose={() => setSubscriptionsOpen(false)}
        />
      )}
      {providerPanel && providersAvailable && (
        <ProvidersDialog
          key={JSON.stringify([plugin.installation, plugin.runtimeGeneration])}
          initialAccountId={providerPanel.accountId}
          onClose={() => setProviderPanel(null)}
          onInventoryChanged={() => {
            void latestRefresh.current()
          }}
        />
      )}
      {details && (
        <ProxyDetails
          row={details}
          groupName={groupName(details)}
          onClose={() => setDetails(null)}
          onEdit={
            details.origin && !providersAvailable
              ? undefined
              : () => {
                  if (details.origin) {
                    if (!providersAvailable) return
                    setProviderPanel({ accountId: details.origin.accountId })
                  } else setForm({ editing: details })
                  setDetails(null)
                }
          }
        />
      )}
      {assigning && (
        <ProxyAssignDialog row={assigning} onClose={() => setAssigning(null)} />
      )}
      {urls && <ProxyUrlsDialog request={urls} onClose={() => setUrls(null)} />}
      <Modal
        open={columnsOpen}
        title="显示列"
        onOpenChange={setColumnsOpen}
        footer={
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            onClick={() => setColumnsOpen(false)}
          >
            完成
          </Button>
        }
      >
        <div className="grid grid-cols-2 gap-4">
          {OPTIONAL_COLUMNS.map((column) => (
            <Checkbox
              key={column.id}
              label={column.label}
              checked={visibleColumns.has(column.id)}
              onCheckedChange={(checked) =>
                setVisibleColumns((current) => {
                  const next = new Set(current)
                  if (checked) next.add(column.id)
                  else next.delete(column.id)
                  return next
                })
              }
            />
          ))}
        </div>
      </Modal>
      <AlertModal
        open={deleting.length > 0}
        status="error"
        title={`删除 ${deleting.length} 条代理`}
        description="代理记录及密码会从插件库存移除。已引用这些端点的 Profile 需要重新选择代理"
        confirmLabel="删除代理"
        isLoading={busy}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting([])
        }}
        onConfirm={() => {
          void run(async () => {
            await proxyPoolApi.remove(deleting)
            setDeleting([])
            setSelected(new Set())
          }, '代理已删除')
        }}
      />
    </>
  )
}

function ProxyFilters({
  query,
  groups,
  disabled,
  onChange,
  onReset,
}: {
  query: ProxyQuery
  groups: ProxyGroup[]
  disabled: boolean
  onChange: (patch: Partial<ProxyQuery>) => void
  onReset: () => void
}) {
  const [riskMin, setRiskMin] = useState(query.riskMin?.toString() ?? '')
  const [riskMax, setRiskMax] = useState(query.riskMax?.toString() ?? '')
  const [error, setError] = useState<string | null>(null)
  const advancedCount = [
    query.isProxy !== null,
    query.isVpn !== null,
    query.isHosting !== null,
    query.riskMin !== null || query.riskMax !== null,
  ].filter(Boolean).length
  return (
    <>
      <Select
        className="w-[88px]!"
        disabled={disabled}
        size="xsmall"
        label="协议"
        value={query.scheme ?? 'all'}
        onChange={(value) =>
          onChange({ scheme: value === 'all' ? null : (value as Scheme) })
        }
        options={[
          { value: 'all', label: '全部协议' },
          ...SCHEMES.map((scheme) => ({ value: scheme, label: scheme.toUpperCase() })),
        ]}
      />
      <Select
        className="w-[88px]!"
        disabled={disabled}
        size="xsmall"
        label="状态"
        value={query.enabled === null ? 'all' : String(query.enabled)}
        onChange={(value) =>
          onChange({ enabled: value === 'all' ? null : value === 'true' })
        }
        options={[
          { value: 'all', label: '全部状态' },
          { value: 'true', label: '启用' },
          { value: 'false', label: '停用' },
        ]}
      />
      <Select
        className="w-[96px]!"
        disabled={disabled}
        size="xsmall"
        label="分组"
        value={query.ungrouped ? 'none' : (query.groupId?.toString() ?? 'all')}
        onChange={(value) =>
          onChange({
            groupId: value === 'none' || value === 'all' ? null : Number(value),
            ungrouped: value === 'none',
          })
        }
        options={[
          { value: 'all', label: '全部分组' },
          { value: 'none', label: '未分组' },
          ...groups.map((group) => ({ value: String(group.id), label: group.name })),
        ]}
      />
      <MorePluginFilters
        label="代理识别与风险范围"
        count={advancedCount}
        disabled={disabled}
      >
        <fieldset
          disabled={disabled}
          className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
        >
          <PluginFilterRow label="代理识别与风险筛选">
            {(
              [
                ['isProxy', '代理识别'],
                ['isVpn', 'VPN 识别'],
                ['isHosting', '数据中心'],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="w-[88px]">
                <Select
                  disabled={disabled}
                  size="xsmall"
                  label={label}
                  value={query[key] === null ? 'all' : String(query[key])}
                  onChange={(value) =>
                    onChange({ [key]: value === 'all' ? null : value === 'true' })
                  }
                  options={[
                    { value: 'all', label: '全部' },
                    { value: 'true', label: '是' },
                    { value: 'false', label: '否' },
                  ]}
                />
              </div>
            ))}
            <div className="w-[88px]">
              <Input
                wrapperClassName="min-w-0"
                label="最低风险"
                inputSize="xsmall"
                inputMode="numeric"
                value={riskMin}
                onChange={(event) => setRiskMin(event.target.value)}
              />
            </div>
            <div className="w-[88px]">
              <Input
                wrapperClassName="min-w-0"
                label="最高风险"
                inputSize="xsmall"
                inputMode="numeric"
                value={riskMax}
                onChange={(event) => setRiskMax(event.target.value)}
              />
            </div>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              className="shrink-0"
              onClick={() => {
                const min = riskMin.trim() === '' ? null : Number(riskMin)
                const max = riskMax.trim() === '' ? null : Number(riskMax)
                if (
                  [min, max].some(
                    (value) =>
                      value !== null &&
                      (!Number.isInteger(value) || value < 0 || value > 100),
                  ) ||
                  (min !== null && max !== null && min > max)
                ) {
                  setError('风险范围需为 0–100 的整数，最低值应小于或等于最高值')
                  return
                }
                setError(null)
                onChange({ riskMin: min, riskMax: max })
              }}
            >
              应用
            </Button>
          </PluginFilterRow>
          {error && (
            <p role="alert" className="m-0 text-secondary text-error-text">
              {error}
            </p>
          )}
        </fieldset>
      </MorePluginFilters>
      <Button
        size="xsmall"
        mode="ghost"
        variant="neutral"
        disabled={disabled}
        onClick={() => {
          setRiskMin('')
          setRiskMax('')
          setError(null)
          onReset()
        }}
      >
        清除
      </Button>
    </>
  )
}

function ProxyUrlsDialog({
  request,
  onClose,
}: {
  request: { ids: string[]; scheme: Scheme | null }
  onClose: () => void
}) {
  const [scheme, setScheme] = useState(request.scheme ?? 'auto')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setBusy(true)
    setText('')
    setError(null)
    void proxyPoolApi
      .exportUrls(request.ids, scheme === 'auto' ? null : (scheme as Scheme))
      .then((data) => {
        if (active) setText(data.urls.join('\n'))
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause))
      })
      .finally(() => {
        if (active) setBusy(false)
      })
    return () => {
      active = false
    }
  }, [request, scheme])
  return (
    <Modal
      open
      title="复制代理 URL"
      size="lg"
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      footer={
        <>
          <Button size="xsmall" mode="stroke" variant="neutral" onClick={onClose}>
            关闭
          </Button>
          <Button
            size="xsmall"
            disabled={busy || !text}
            onClick={() => {
              void clip.write(text).then(
                () => toast.ok('已复制代理 URL'),
                () => setError('剪贴板写入失败'),
              )
            }}
          >
            复制 URL
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select
          label="协议"
          size="xsmall"
          value={scheme}
          onChange={setScheme}
          options={[
            { value: 'auto', label: '自动选择' },
            ...SCHEMES.map((value) => ({ value, label: value.toUpperCase() })),
          ]}
        />
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        <Textarea
          label="代理 URL"
          technical
          rows={8}
          readOnly
          value={text}
          hint="URL 隐去密码，使用前需要补入密码"
        />
      </div>
    </Modal>
  )
}
