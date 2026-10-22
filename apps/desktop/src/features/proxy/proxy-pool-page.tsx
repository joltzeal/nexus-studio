import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Gauge,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Star,
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
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { FieldError } from '@/components/ui/field'
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
  checkProxy,
  deleteProxies,
  getConfig,
  listGroups,
  listProxies,
  setConfig as saveConfig,
} from './api'
import { DetectionCell, QualityCell } from './proxy-detail'
import { ProxyBatchSheet } from './proxy-batch-sheet'
import { ProxyConfigSheet } from './proxy-config-sheet'
import { ProxyFilters } from './proxy-filters'
import { ProxyFormSheet } from './proxy-form-sheet'
import { ProxySelect } from './proxy-select'
import { ProxySubscriptionSheet } from './proxy-subscription-sheet'
import { ProxyUrlSheet } from './proxy-url-sheet'
import {
  EMPTY_QUERY,
  SCHEMES,
  activeFilterCount,
  addressOf,
  message,
  type ProxyConfig,
  type ProxyGroup,
  type ProxyListQuery,
  type ProxyRow,
  type Scheme,
} from './types'
import {
  listPlugins,
  pluginHostAvailable,
  type PluginView,
} from '@/lib/platform/native-plugins'
import { PluginGate } from '@/features/plugins/plugin-gate'

export const PROXY_PLUGIN_ID = 'studio.proxy-pool'

const PAGE_SIZES = [10, 50, 100, 200, 500]
const CHECK_CONCURRENCY = 4

type SortKey = 'name' | 'host' | 'port' | 'username' | 'enabled' | 'detection' | 'quality'
type SortDir = 'asc' | 'desc'

interface ColumnVisibility {
  group: boolean
  schemes: boolean
  username: boolean
  password: boolean
  detection: boolean
  quality: boolean
}

const COLUMNS: { key: keyof ColumnVisibility; label: string }[] = [
  { key: 'group', label: '代理分组' },
  { key: 'schemes', label: '支持协议' },
  { key: 'username', label: '用户名' },
  { key: 'password', label: '密码' },
  { key: 'detection', label: '检测信息' },
  { key: 'quality', label: 'IP 质量' },
]

const DEFAULT_COLUMNS: ColumnVisibility = {
  group: true,
  schemes: true,
  username: true,
  password: false,
  detection: true,
  quality: true,
}

function sortValue(row: ProxyRow, key: SortKey): string | number {
  switch (key) {
    case 'name':
      return row.name.toLowerCase()
    case 'host':
      return row.host
    case 'port':
      return row.port
    case 'username':
      return row.username.toLowerCase()
    case 'enabled':
      return row.enabled ? 1 : 0
    case 'detection':
      return row.geo?.country ?? ''
    case 'quality':
      return row.reputation?.status === 'ok' ? (row.reputation.risk ?? 101) : 101
  }
}

export interface ProxyPoolPageProps {
  plugin: PluginView | null
  hostAvailable: boolean
}

/** Page shell shared by the table and the placeholder states. */
function ProxyShell({ children }: { children: ReactNode }) {
  return (
    <section className="collection-page page-reveal" aria-labelledby="proxy-heading">
      <div className="section-intro">
        <h1 className="page-heading" id="proxy-heading">
          代理池
        </h1>
      </div>
      {children}
    </section>
  )
}

export function ProxyPoolPage({ plugin, hostAvailable }: ProxyPoolPageProps) {
  const running = plugin?.state === 'running'
  const [rows, setRows] = useState<ProxyRow[]>([])
  const [total, setTotal] = useState(0)
  const [groups, setGroups] = useState<ProxyGroup[]>([])
  const [config, setConfig] = useState<ProxyConfig | null>(null)
  const [applied, setApplied] = useState<ProxyListQuery>(EMPTY_QUERY)
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null)
  const [columns, setColumns] = useState<ColumnVisibility>(DEFAULT_COLUMNS)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ProxyRow | null>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  const [urlRequest, setUrlRequest] = useState<{
    ids: string[]
    scheme: Scheme | null
    autoCopy: boolean
  } | null>(null)
  const [subsOpen, setSubsOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [deleteIds, setDeleteIds] = useState<string[]>([])
  const [progress, setProgress] = useState<{
    total: number
    done: number
    failed: number
  } | null>(null)
  const runningCheck = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const [list, groupList, configView] = await Promise.all([
      listProxies(applied),
      listGroups(),
      getConfig(),
    ])
    if (!alive.current) return
    setRows(list.items)
    setTotal(list.total)
    setGroups(groupList.items)
    setConfig(configView)
  }, [applied])

  useEffect(() => {
    if (!running) return
    let active = true
    void load().then(
      () => {
        if (active) setError(null)
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [running, load])

  // Typing must not fire a request per keystroke; the plugin is local but the
  // table still flickers if every character refetches.
  useEffect(() => {
    if (keyword === applied.keyword) return
    const timer = setTimeout(() => {
      setApplied((current) => ({ ...current, keyword, offset: 0 }))
      setSelection(new Set())
    }, 250)
    return () => clearTimeout(timer)
  }, [keyword, applied.keyword])

  const pageIndex = Math.floor(applied.offset / applied.limit)
  const pageCount = Math.max(1, Math.ceil(total / applied.limit))
  const filters = activeFilterCount(applied)

  const visibleRows = useMemo(() => {
    if (sort === null) return rows
    const factor = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((left, right) => {
      const a = sortValue(left, sort.key)
      const b = sortValue(right, sort.key)
      if (a === b) return 0
      return (a < b ? -1 : 1) * factor
    })
  }, [rows, sort])

  const allSelected = rows.length > 0 && rows.every((row) => selection.has(row.id))
  const someSelected = selection.size > 0 && !allSelected
  const selectedIds = useMemo(
    () => rows.filter((row) => selection.has(row.id)).map((row) => row.id),
    [rows, selection],
  )

  function patchQuery(patch: Partial<ProxyListQuery>) {
    setApplied((current) => ({ ...current, ...patch }))
    setSelection(new Set())
  }

  function toggleRow(id: string, checked: boolean) {
    setSelection((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleAll(checked: boolean) {
    setSelection(checked ? new Set(rows.map((row) => row.id)) : new Set())
  }

  async function refresh() {
    setLoading(true)
    try {
      await load()
      setError(null)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setLoading(false)
    }
  }

  /** Runs checks four at a time and reports honest progress, including failures. */
  async function runChecks(
    ids: string[],
    scheme: Scheme | null,
    singleSchemeFallback: boolean,
  ) {
    if (runningCheck.current || ids.length === 0) return
    runningCheck.current = true
    setError(null)
    let cursor = 0
    let done = 0
    let failed = 0
    setProgress({ total: ids.length, done, failed })
    try {
      await Promise.all(
        Array.from({ length: Math.min(CHECK_CONCURRENCY, ids.length) }, async () => {
          while (cursor < ids.length) {
            const id = ids[cursor]
            cursor += 1
            if (id === undefined) break
            try {
              const result = await checkProxy(id, scheme, singleSchemeFallback)
              if (!result.ok) failed += 1
            } catch (cause) {
              failed += 1
              if (alive.current) setError(message(cause))
            }
            done += 1
            if (alive.current) setProgress({ total: ids.length, done, failed })
          }
        }),
      )
    } finally {
      runningCheck.current = false
      if (alive.current) {
        await refresh()
        setProgress({ total: ids.length, done, failed })
      }
    }
  }

  async function removeSelected(ids: string[]) {
    try {
      await deleteProxies(ids)
      setDeleteIds([])
      setSelection(new Set())
      const removedHere = rows.filter((row) => ids.includes(row.id)).length
      // Deleting the last rows of a page should not leave an empty page behind.
      if (pageIndex > 0 && removedHere === rows.length) {
        setApplied((current) => ({
          ...current,
          offset: Math.max(0, current.offset - current.limit),
        }))
      } else {
        await refresh()
      }
    } catch (cause) {
      setError(message(cause))
    }
  }

  function header(key: SortKey, label: string, enabled = true) {
    if (!enabled) return <TableHead>{label}</TableHead>
    const active = sort?.key === key
    const Icon = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
    return (
      <TableHead>
        <button
          type="button"
          className="proxy-sort"
          aria-pressed={active}
          title="仅排序当前页数据"
          onClick={() =>
            setSort((current) =>
              current?.key !== key
                ? { key, dir: 'asc' }
                : current.dir === 'asc'
                  ? { key, dir: 'desc' }
                  : null,
            )
          }
        >
          {label}
          <Icon aria-hidden="true" />
        </button>
      </TableHead>
    )
  }

  if (!running) {
    return (
      <ProxyShell>
        <PluginGate label="代理池" plugin={plugin} hostAvailable={hostAvailable} />
      </ProxyShell>
    )
  }

  return (
    <section className="collection-page page-reveal" aria-labelledby="proxy-heading">
      <div className="section-intro">
        <div>
          <h1 className="page-heading" id="proxy-heading">
            代理池
          </h1>
          <p className="page-description">
            库存、检测与订阅由插件进程提供；密码保存在插件私有目录。
          </p>
        </div>
        <div className="proxy-toolbar">
          <Button
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            <Plus data-icon="inline-start" />
            新增代理
          </Button>
          <Button variant="outline" onClick={() => setBatchOpen(true)}>
            批量添加
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                disabled={selectedIds.length === 0 || progress !== null}
              >
                <Gauge data-icon="inline-start" />
                检测选中
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuGroup>
                <DropdownMenuLabel>检测协议</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => void runChecks(selectedIds, null, true)}>
                  自动选择协议
                </DropdownMenuItem>
                {SCHEMES.map((scheme) => (
                  <DropdownMenuItem
                    key={scheme}
                    onClick={() => void runChecks(selectedIds, scheme, true)}
                  >
                    {scheme.toUpperCase()}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <p className="proxy-menu-note">
                单协议代理使用自带协议，多协议代理使用所选协议。
              </p>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            disabled={selectedIds.length === 0}
            onClick={() =>
              setUrlRequest({ ids: selectedIds, scheme: null, autoCopy: false })
            }
          >
            <Copy data-icon="inline-start" />
            复制 URL
          </Button>
          <Button variant="outline" onClick={() => setSubsOpen(true)}>
            订阅
          </Button>
          <Button
            variant="outline"
            disabled={selectedIds.length === 0}
            onClick={() => setDeleteIds(selectedIds)}
          >
            <Trash2 data-icon="inline-start" />
            删除选中
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新"
            onClick={() => void refresh()}
          >
            {loading ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="代理插件配置"
            onClick={() => setConfigOpen(true)}
          >
            <Settings2 aria-hidden="true" />
          </Button>
        </div>
      </div>

      {error === null ? null : <FieldError role="alert">{error}</FieldError>}
      {progress === null ? null : (
        <p className="proxy-progress" role="status">
          代理检测：{progress.done} / {progress.total}
          {progress.done === progress.total ? `，失败 ${progress.failed} 条。` : '…'}
        </p>
      )}

      <ProxyFilters
        query={{ ...applied, keyword }}
        groups={groups}
        activeCount={filters}
        busy={loading}
        onChange={(patch) => {
          if (patch.keyword !== undefined) {
            setKeyword(patch.keyword)
            return
          }
          patchQuery(patch)
        }}
        onReset={() => {
          setKeyword('')
          setApplied({ ...EMPTY_QUERY, limit: applied.limit })
          setSelection(new Set())
        }}
      />

      <div className="space-table-panel">
        <div className="panel-heading">
          <h2>代理库存</h2>
          <Badge variant="secondary">{total}</Badge>
          {selectedIds.length > 0 ? (
            <span className="proxy-selected">已选中 {selectedIds.length} 条</span>
          ) : null}
          {config?.defaultEndpointId === null ? (
            <span className="proxy-selected">未设置默认代理，窗口启动会被阻断</span>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="proxy-columns">
                <Columns3 data-icon="inline-start" />列
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>显示列</DropdownMenuLabel>
              {COLUMNS.map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.key}
                  checked={columns[column.key]}
                  onCheckedChange={(checked) =>
                    setColumns((current) => ({
                      ...current,
                      [column.key]: checked === true,
                    }))
                  }
                  onSelect={(event) => event.preventDefault()}
                >
                  {column.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="proxy-table-scroll">
          <Table aria-label="代理列表">
            <TableHeader>
              <TableRow>
                <TableHead className="proxy-check-cell">
                  <Checkbox
                    aria-label="全选当前页"
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={(checked) => toggleAll(checked === true)}
                  />
                </TableHead>
                {header('name', '名称')}
                {columns.group ? <TableHead>代理分组</TableHead> : null}
                {columns.schemes ? <TableHead>支持协议</TableHead> : null}
                {header('host', '主机地址')}
                {header('port', '端口')}
                {columns.username ? header('username', '用户名') : null}
                {columns.password ? <TableHead>密码</TableHead> : null}
                {header('enabled', '状态')}
                {columns.detection ? header('detection', '检测信息') : null}
                {columns.quality ? header('quality', 'IP 质量') : null}
                <TableHead className="proxy-actions-head">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row) => {
                const isDefault = config?.defaultEndpointId === row.id
                return (
                  <TableRow
                    key={row.id}
                    data-selected={selection.has(row.id) ? 'true' : 'false'}
                  >
                    <TableCell className="proxy-check-cell">
                      <Checkbox
                        aria-label={`选择 ${row.name}`}
                        checked={selection.has(row.id)}
                        onCheckedChange={(checked) => toggleRow(row.id, checked === true)}
                      />
                    </TableCell>
                    <TableCell>
                      <span className="proxy-name">
                        {row.name}
                        {isDefault ? <Badge variant="outline">默认</Badge> : null}
                      </span>
                    </TableCell>
                    {columns.group ? (
                      <TableCell>
                        {row.groupId === null ? (
                          <span className="proxy-muted">未分组</span>
                        ) : (
                          (groups.find((group) => String(group.id) === row.groupId)
                            ?.name ?? '当前分组')
                        )}
                      </TableCell>
                    ) : null}
                    {columns.schemes ? (
                      <TableCell>
                        <span className="proxy-schemes">
                          {row.schemes.map((scheme) => (
                            <Badge variant="outline" key={scheme}>
                              {scheme.toUpperCase()}
                            </Badge>
                          ))}
                        </span>
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <code className="proxy-address">{addressOf(row)}</code>
                    </TableCell>
                    <TableCell>{row.port}</TableCell>
                    {columns.username ? (
                      <TableCell>{row.username === '' ? '—' : row.username}</TableCell>
                    ) : null}
                    {columns.password ? (
                      <TableCell>{row.hasPassword ? '已配置' : '—'}</TableCell>
                    ) : null}
                    <TableCell>
                      <Badge variant={row.enabled ? 'secondary' : 'outline'}>
                        {row.enabled ? '启用' : '停用'}
                      </Badge>
                    </TableCell>
                    {columns.detection ? (
                      <TableCell>
                        <DetectionCell row={row} />
                      </TableCell>
                    ) : null}
                    {columns.quality ? (
                      <TableCell>
                        <QualityCell row={row} />
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <div className="proxy-row-actions">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`操作 ${row.name}`}
                            >
                              <MoreHorizontal aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {row.schemes.length === 1 ? (
                              <DropdownMenuItem
                                onClick={() =>
                                  setUrlRequest({
                                    ids: [row.id],
                                    scheme: row.schemes[0] ?? null,
                                    autoCopy: true,
                                  })
                                }
                              >
                                <Copy />
                                复制代理 URL
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                  <Copy />
                                  复制代理 URL
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                  {row.schemes.map((scheme) => (
                                    <DropdownMenuItem
                                      key={scheme}
                                      onClick={() =>
                                        setUrlRequest({
                                          ids: [row.id],
                                          scheme,
                                          autoCopy: true,
                                        })
                                      }
                                    >
                                      {scheme.toUpperCase()}
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuSubContent>
                              </DropdownMenuSub>
                            )}
                            {row.schemes.map((scheme) => (
                              <DropdownMenuItem
                                key={scheme}
                                disabled={progress !== null}
                                onClick={() => void runChecks([row.id], scheme, false)}
                              >
                                <Gauge />
                                检测 {scheme.toUpperCase()}
                              </DropdownMenuItem>
                            ))}
                            <DropdownMenuItem
                              disabled={isDefault}
                              onClick={() => {
                                void saveConfig({
                                  defaultEndpointId: row.id,
                                  riskEnabled: config?.risk.enabled ?? true,
                                  riskCacheSeconds: config?.risk.cacheSeconds ?? 3600,
                                }).then(
                                  (next) => {
                                    setConfig(next)
                                    toast.success(`已将「${row.name}」设为默认代理`)
                                  },
                                  (cause: unknown) => setError(message(cause)),
                                )
                              }}
                            >
                              <Star />
                              设为默认代理
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                setEditing(row)
                                setFormOpen(true)
                              }}
                            >
                              <Pencil />
                              编辑
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setDeleteIds([row.id])}
                            >
                              <Trash2 />
                              删除
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        {visibleRows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{filters > 0 ? '没有符合条件的代理' : '还没有代理'}</EmptyTitle>
              <EmptyDescription>
                {filters > 0
                  ? '调整筛选条件，或清除筛选后重试。'
                  : '单条添加、粘贴 URL 列表，或按 Decodo 端口范围生成。'}
              </EmptyDescription>
            </EmptyHeader>
            {filters > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setKeyword('')
                  setApplied({ ...EMPTY_QUERY, limit: applied.limit })
                  setSelection(new Set())
                }}
              >
                清除筛选
              </Button>
            ) : null}
          </Empty>
        ) : null}
        <div className="proxy-pagination">
          <span className="result-count">
            共 {total} 条 · 第 {pageIndex + 1} / {pageCount} 页
          </span>
          <div className="proxy-pagination-controls">
            <ProxySelect
              ariaLabel="每页条数"
              className="proxy-page-size"
              value={String(applied.limit)}
              onValueChange={(value) => patchQuery({ limit: Number(value), offset: 0 })}
              options={PAGE_SIZES.map((size) => ({
                value: String(size),
                label: `每页 ${size}`,
              }))}
            />
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="上一页"
              disabled={pageIndex === 0 || loading}
              onClick={() =>
                patchQuery({ offset: Math.max(0, applied.offset - applied.limit) })
              }
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="下一页"
              disabled={pageIndex + 1 >= pageCount || loading}
              onClick={() => patchQuery({ offset: applied.offset + applied.limit })}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>

      {formOpen ? (
        <ProxyFormSheet
          editing={editing}
          groups={groups}
          onOpenChange={(next) => {
            setFormOpen(next)
            if (!next) setEditing(null)
          }}
          onSaved={refresh}
        />
      ) : null}
      {batchOpen ? (
        <ProxyBatchSheet
          groups={groups}
          onOpenChange={setBatchOpen}
          onImported={refresh}
        />
      ) : null}
      {urlRequest === null ? null : (
        <ProxyUrlSheet
          ids={urlRequest.ids}
          scheme={urlRequest.scheme}
          autoCopy={urlRequest.autoCopy}
          onOpenChange={(next) => {
            if (!next) setUrlRequest(null)
          }}
          onCopied={(count) => toast.success(`已复制 ${count} 条代理 URL（不含密码）`)}
        />
      )}
      {subsOpen ? (
        <ProxySubscriptionSheet
          selectedIds={selectedIds}
          groups={groups}
          onOpenChange={setSubsOpen}
        />
      ) : null}
      {configOpen && config !== null ? (
        <ProxyConfigSheet
          config={config}
          rows={rows}
          onOpenChange={setConfigOpen}
          onSaved={(next) => {
            setConfig(next)
            toast.success('配置已保存')
          }}
        />
      ) : null}
      <AlertDialog
        open={deleteIds.length > 0}
        onOpenChange={(next) => {
          if (!next) setDeleteIds([])
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 {deleteIds.length} 条代理？</AlertDialogTitle>
            <AlertDialogDescription>
              记录与密码一起从插件私有目录删除，无法撤销。已引用这些代理的窗口需要重新选择代理。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault()
                void removeSelected(deleteIds)
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

/**
 * Resolves the plugin's current state before rendering the pool. The page never
 * guesses: it shows exactly what the host reports.
 */
export function ProxyPoolRoute() {
  const hostAvailable = pluginHostAvailable()
  const [plugin, setPlugin] = useState<PluginView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!hostAvailable) return
    try {
      const catalog = await listPlugins()
      setPlugin(catalog.find((entry) => entry.id === PROXY_PLUGIN_ID) ?? null)
    } catch (cause) {
      setError(message(cause))
    }
  }, [hostAvailable])

  useEffect(() => {
    if (!hostAvailable) return
    let active = true
    void listPlugins().then(
      (catalog) => {
        if (active)
          setPlugin(catalog.find((entry) => entry.id === PROXY_PLUGIN_ID) ?? null)
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [hostAvailable])

  // The host has no push channel: keep looking while the process is coming up.
  const pending = plugin === null || plugin.state !== 'running'
  useEffect(() => {
    if (!hostAvailable || !pending) return
    const timer = setInterval(() => {
      void refresh()
    }, 2000)
    return () => clearInterval(timer)
  }, [hostAvailable, pending, refresh])

  return (
    <>
      {error === null ? null : <FieldError role="alert">{error}</FieldError>}
      <ProxyPoolPage plugin={plugin} hostAvailable={hostAvailable} />
    </>
  )
}
