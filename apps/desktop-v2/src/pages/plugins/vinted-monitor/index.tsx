import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  AlertModal,
  Button,
  Checkbox,
  EmptyState,
  Input,
  Modal,
  Select,
  Textarea,
} from '@proxyshard/shardx-ui-kit'
import { HeaderMenu, PageHeader } from '../../../widgets/PageHeader'
import { MorePluginFilters, PluginFilterRow, PluginSearch } from '../PluginFilterRow'
import { PluginRowAction } from '../PluginRowAction'
import { PluginWorkspace } from '../PluginWorkspace'
import { AiImagePage, SourceImageHistoryDialog } from '../ai-image'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import { isNativeRaccoon } from '../../../raccoon/runtime'
import { toast } from '../../../shared/model/toast'
import { clip } from '../../../shared/lib/clipboard'
import { invoke } from '../../../shared/api/invoke'
import {
  ClockIcon,
  DeleteIcon,
  EditIcon,
  PlayIcon,
  StarOutlineIcon,
  UnstarIcon,
} from '../../../shared/icons'
import { supportsAiPage } from '../../../raccoon/plugins/ai-image/page-contract'
import type { AiImageHandoff } from '../../../raccoon/plugins/ai-image/types'
import {
  supportsVintedImages,
  supportsVintedMonitor,
  VINTED_PLUGIN_ID,
} from '../../../raccoon/plugins/vinted-monitor/page-contract'
import { loadVintedImage as imageLoader } from '../../../raccoon/plugins/vinted-monitor/image-transfer'
import { vintedMonitorApi } from '../../../raccoon/plugins/vinted-monitor/api'
import {
  AVAILABILITY_LABELS,
  EMPTY_FILTERS,
  errorMessage,
  formatTime,
  itemFilterParams,
  itemHandoff,
  itemReferencePhotos,
  monitorKindLabel,
  RUN_STATUS_LABELS,
  type AvailabilityStatus,
  type FilterDraft,
  type Item,
  type ItemSummary,
  type Monitor,
  type MonitorInput,
  type MonitorProxy,
  type ProxyInput,
  type Run,
  type Page,
} from '../../../raccoon/plugins/vinted-monitor/model'

type Dialog =
  | { kind: 'monitor'; value: Monitor | null }
  | { kind: 'proxy'; value: MonitorProxy | null }
  | { kind: 'item'; value: Item }
  | { kind: 'runs'; monitor: Monitor }
  | { kind: 'remove-monitor'; monitor: Monitor }
  | { kind: 'remove-item'; item: ItemSummary }
  | { kind: 'handoff'; handoffs: AiImageHandoff[] }
  | { kind: 'history'; item: Item }
  | null

const blankMonitor: MonitorInput = {
  name: '',
  searchUrl: '',
  proxyId: null,
  intervalMinutes: 10,
  maxPages: 3,
  perPage: 20,
  enabled: true,
}
const blankProxy: ProxyInput = {
  name: '',
  scheme: 'http',
  host: '',
  port: 8080,
  username: '',
  enabled: true,
}

function message(cause: unknown) {
  return errorMessage(cause)
}

export function VintedMonitorPage({ onManage }: { onManage: () => void }) {
  const plugin = usePluginCatalog((state) =>
    state.plugins.find((entry) => entry.id === VINTED_PLUGIN_ID),
  )
  const compatible = supportsVintedMonitor(plugin)
  const ready = isNativeRaccoon() && compatible
  const canImages = supportsVintedImages(plugin)
  const ai = usePluginCatalog((state) =>
    state.plugins.find((entry) => entry.id === 'studio.ai-image'),
  )
  const canAi = supportsAiPage(ai)
  const [monitors, setMonitors] = useState<Monitor[]>([])
  const [proxies, setProxies] = useState<MonitorProxy[]>([])
  const [defaultProxyId, setDefaultProxyId] = useState<string | null>(null)
  const [items, setItems] = useState<ItemSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [filters, setFilters] = useState<FilterDraft>({ ...EMPTY_FILTERS })
  const [dialog, setDialog] = useState<Dialog>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [reading, setReading] = useState(true)
  const [readError, setReadError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [selection, setSelection] = useState<string[]>([])
  const operation = useRef<AbortController | null>(null)
  const refreshSequence = useRef(0)
  const refresh = () => setRevision((current) => current + 1)

  useEffect(() => {
    if (!ready) return
    const sequence = ++refreshSequence.current
    let timer: ReturnType<typeof setTimeout>
    async function read(initial: boolean) {
      let delay = 15000
      try {
        const query = itemFilterParams(filters)
        const [monitorPage, proxyPage, itemPage] = await Promise.all([
          vintedMonitorApi.monitors(),
          vintedMonitorApi.proxies(),
          vintedMonitorApi.items({ ...query, page, pageSize: 20 }),
        ])
        if (sequence !== refreshSequence.current) return
        delay = monitorPage.items.some((monitor) => monitor.lastStatus === 'running')
          ? 3000
          : 15000
        setMonitors(monitorPage.items)
        setProxies(proxyPage.items)
        setDefaultProxyId(proxyPage.defaultProxyId)
        setItems(itemPage.items)
        setTotal(itemPage.total)
        setLoaded(true)
        setReadError(null)
        if (page > 0 && page >= itemPage.totalPages) {
          setSelection([])
          setPage(Math.max(0, itemPage.totalPages - 1))
        }
      } catch (cause) {
        if (sequence === refreshSequence.current) setReadError(message(cause))
      } finally {
        if (sequence === refreshSequence.current) {
          if (initial) setReading(false)
          timer = setTimeout(() => void read(false), delay)
        }
      }
    }
    setReading(true)
    timer = setTimeout(() => void read(true), 180)
    return () => {
      refreshSequence.current += 1
      clearTimeout(timer)
    }
  }, [ready, filters, page, revision])
  useEffect(() => () => operation.current?.abort(), [])

  async function mutate(
    action: (signal: AbortSignal) => Promise<unknown>,
    success?: string,
    reload = true,
  ): Promise<boolean> {
    if (operation.current) return false
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError(null)
    try {
      await action(controller.signal)
      if (controller.signal.aborted) return false
      if (success) toast.ok(success)
      if (reload) refresh()
      return true
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause))
      return false
    } finally {
      operation.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  async function openItem(item: ItemSummary) {
    await mutate(
      async (signal) => {
        const { item: value } = await vintedMonitorApi.getItem(item.id)
        if (!signal.aborted) setDialog({ kind: 'item', value })
      },
      undefined,
      false,
    )
  }

  async function openBatch() {
    await mutate(
      async (signal) => {
        const handoffs: AiImageHandoff[] = []
        for (const id of selection.filter((id) => items.some((item) => item.id === id))) {
          signal.throwIfAborted()
          const { item } = await vintedMonitorApi.getItem(id)
          const photos = itemReferencePhotos(item).slice(0, 6)
          if (!photos.length)
            throw new Error(`「${item.title || item.externalId}」没有可用参考图。`)
          handoffs.push(itemHandoff(item, photos))
        }
        if (!signal.aborted && handoffs.length > 0)
          setDialog({ kind: 'handoff', handoffs })
      },
      undefined,
      false,
    )
  }

  if (!ready) {
    const title = !isNativeRaccoon()
      ? '桌面应用中使用 Vinted 监控'
      : plugin?.state === 'unlicensed'
        ? 'Vinted 监控插件需要激活'
        : plugin?.state === 'running'
          ? 'Vinted 监控插件接口需要更新'
          : 'Vinted 监控插件尚未就绪'
    return (
      <>
        <PageHeader
          title="Vinted 商品监控"
          actions={
            <Button size="xsmall" mode="stroke" variant="neutral" onClick={onManage}>
              管理插件
            </Button>
          }
        />
        <PluginWorkspace>
          <EmptyState
            title={title}
            hint="请在桌面应用中启动已授权的监控插件。"
            action={{ label: '管理插件', onClick: onManage }}
          />
        </PluginWorkspace>
      </>
    )
  }

  const selectedMonitor = filters.monitorId
  const filterUpdate = (patch: Partial<FilterDraft>) => {
    setFilters((current) => ({ ...current, ...patch }))
    setPage(0)
    setSelection([])
  }

  return (
    <>
      <PageHeader
        title="Vinted 商品监控"
        count={total}
        actions={
          <>
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              disabled={busy}
              onClick={() => void refresh()}
            >
              刷新
            </Button>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              onClick={() => setDialog({ kind: 'proxy', value: null })}
            >
              采集代理 · {proxies.length}
            </Button>
            <Button
              size="xsmall"
              onClick={() => setDialog({ kind: 'monitor', value: null })}
            >
              新建监控
            </Button>
            <HeaderMenu
              label="商品监控选项"
              items={[{ label: '管理插件', onSelect: onManage }]}
            />
          </>
        }
      />
      <PluginWorkspace scroll>
        <PluginFilterRow label="商品归档筛选">
          <PluginSearch
            pageShortcut
            label="搜索商品"
            value={filters.keyword}
            maxLength={100}
            placeholder="标题、品牌、卖家或来源 ID"
            onChange={(event) => filterUpdate({ keyword: event.target.value })}
          />
          <Select
            className="w-[104px]!"
            size="xsmall"
            label="监控来源"
            value={selectedMonitor}
            options={[
              { value: '', label: '全部监控' },
              ...monitors.map((monitor) => ({ value: monitor.id, label: monitor.name })),
            ]}
            onChange={(value) => filterUpdate({ monitorId: value })}
          />
          <Select
            className="w-[88px]!"
            size="xsmall"
            label="状态"
            value={filters.availabilityStatus}
            options={[
              { value: '', label: '全部状态' },
              ...Object.entries(AVAILABILITY_LABELS).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
            onChange={(value) => filterUpdate({ availabilityStatus: value })}
          />
          <Select
            className="w-[80px]!"
            size="xsmall"
            label="收藏"
            value={filters.starred}
            options={[
              { value: '', label: '全部' },
              { value: 'true', label: '已收藏' },
              { value: 'false', label: '未收藏' },
            ]}
            onChange={(value) => filterUpdate({ starred: value })}
          />
          <Select
            className="w-[96px]!"
            size="xsmall"
            label="排序"
            value={filters.order}
            options={[
              { value: 'collected_desc', label: '最近采集' },
              { value: 'favourite_desc', label: '收藏最多' },
              { value: 'favourite_asc', label: '收藏最少' },
            ]}
            onChange={(value) => filterUpdate({ order: value })}
          />
          <MorePluginFilters
            label="来源商品 ID 与收藏数"
            count={
              Number(Boolean(filters.externalId.trim())) +
              Number(Boolean(filters.favouriteCountOp))
            }
          >
            <PluginFilterRow label="商品高级条件">
              <Input
                wrapperClassName="min-w-[128px] flex-1"
                label="来源商品 ID"
                inputSize="xsmall"
                inputMode="numeric"
                maxLength={32}
                value={filters.externalId}
                onChange={(event) => filterUpdate({ externalId: event.target.value })}
              />
              <Select
                className="w-[112px]!"
                size="xsmall"
                label="收藏数条件"
                value={filters.favouriteCountOp}
                options={[
                  { value: '', label: '不筛选' },
                  { value: 'eq', label: '等于' },
                  { value: 'ne', label: '不等于' },
                  { value: 'gt', label: '大于' },
                  { value: 'ge', label: '大于等于' },
                  { value: 'lt', label: '小于' },
                  { value: 'le', label: '小于等于' },
                  { value: 'between', label: '范围' },
                  { value: 'isNull', label: '未提供' },
                  { value: 'notNull', label: '已提供' },
                ]}
                onChange={(value) => filterUpdate({ favouriteCountOp: value })}
              />
              {filters.favouriteCountOp &&
                filters.favouriteCountOp !== 'isNull' &&
                filters.favouriteCountOp !== 'notNull' && (
                  <Input
                    wrapperClassName="w-[96px]!"
                    label={
                      filters.favouriteCountOp === 'between' ? '收藏数下限' : '收藏数'
                    }
                    inputSize="xsmall"
                    type="number"
                    value={filters.favouriteCount}
                    onChange={(event) =>
                      filterUpdate({ favouriteCount: event.target.value })
                    }
                  />
                )}
              {filters.favouriteCountOp === 'between' && (
                <Input
                  wrapperClassName="w-[96px]!"
                  label="收藏数上限"
                  inputSize="xsmall"
                  type="number"
                  value={filters.favouriteCountEnd}
                  onChange={(event) =>
                    filterUpdate({ favouriteCountEnd: event.target.value })
                  }
                />
              )}
            </PluginFilterRow>
          </MorePluginFilters>
          <Button
            size="xsmall"
            mode="ghost"
            variant="neutral"
            onClick={() => {
              setFilters({ ...EMPTY_FILTERS })
              setPage(0)
              setSelection([])
            }}
          >
            清除
          </Button>
        </PluginFilterRow>
        {canImages && canAi && selection.length > 0 && (
          <div className="flex items-center gap-2">
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              disabled={busy || reading || !!readError}
              onClick={() => void openBatch()}
            >
              批量生图 · {selection.length} 件
            </Button>
          </div>
        )}
        {readError && (
          <Alert status="error" variant="lighter">
            {readError}
          </Alert>
        )}
        {error && dialog?.kind !== 'remove-monitor' && dialog?.kind !== 'remove-item' && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        <section className="border-b border-stroke-soft-200 pb-3" aria-label="监控列表">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-section-title text-text-strong-950">监控配置</h2>
            <span className="text-secondary text-text-soft-400">
              {monitors.length} 个
            </span>
          </div>
          <div className="grid max-h-[192px] gap-2 overflow-auto lg:grid-cols-2">
            {monitors.map((monitor) => (
              <div
                key={monitor.id}
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-control bg-bg-weak-50 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-body font-medium text-text-strong-950">
                    {monitor.name}
                  </div>
                  <div className="text-secondary text-text-sub-600">
                    {monitorKindLabel(monitor.kind)} · 每 {monitor.intervalMinutes} 分钟 ·{' '}
                    {monitor.lastStatus
                      ? RUN_STATUS_LABELS[monitor.lastStatus]
                      : '未运行'}
                  </div>
                </div>
                <div className="flex shrink-0 flex-nowrap items-center gap-1">
                  <PluginRowAction
                    label="运行监控"
                    icon={<PlayIcon className="size-3.5" />}
                    disabled={
                      busy ||
                      !monitor.enabled ||
                      monitors.some((entry) => entry.lastStatus === 'running')
                    }
                    onClick={() =>
                      void mutate(() => vintedMonitorApi.runMonitor(monitor.id))
                    }
                  />
                  <PluginRowAction
                    label="运行历史"
                    icon={<ClockIcon className="size-3.5" />}
                    onClick={() => setDialog({ kind: 'runs', monitor })}
                  />
                  <PluginRowAction
                    label="编辑监控"
                    icon={<EditIcon className="size-3.5" />}
                    onClick={() => setDialog({ kind: 'monitor', value: monitor })}
                  />
                  <PluginRowAction
                    label="删除监控"
                    icon={<DeleteIcon className="size-3.5" />}
                    variant="error"
                    onClick={() => {
                      setError(null)
                      setDialog({ kind: 'remove-monitor', monitor })
                    }}
                  />
                </div>
              </div>
            ))}
            {!monitors.length && loaded && (
              <div className="text-secondary text-text-soft-400">暂无监控配置</div>
            )}
          </div>
        </section>
        <section className="min-w-0" aria-label="商品归档">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-section-title text-text-strong-950">商品归档</h2>
            <span className="text-secondary text-text-soft-400">共 {total} 件</span>
          </div>
          <div className="overflow-x-auto border-y border-stroke-soft-200">
            <table className="w-full text-left text-secondary">
              <thead>
                <tr className="border-b border-stroke-soft-200 text-text-soft-400">
                  <th className="px-3 py-2">商品</th>
                  <th className="px-3 py-2">监控</th>
                  <th className="px-3 py-2">收藏</th>
                  <th className="px-3 py-2">状态</th>
                  <th className="px-3 py-2">采集时间</th>
                  <th className="px-3 py-2 whitespace-nowrap">操作</th>
                </tr>
              </thead>
              <tbody>
                {!reading &&
                  !readError &&
                  items.map((item) => (
                    <tr
                      key={item.id}
                      className="border-b border-stroke-soft-200 last:border-0"
                    >
                      <td className="max-w-[280px] px-3 py-2">
                        {canImages && canAi && (
                          <Checkbox
                            label={`选择 ${item.title || item.externalId}`}
                            checked={selection.includes(item.id)}
                            disabled={busy}
                            onChange={(event) => {
                              const checked = event.target.checked
                              setSelection((current) =>
                                checked
                                  ? [...current, item.id]
                                  : current.filter((id) => id !== item.id),
                              )
                            }}
                          />
                        )}
                        <Button
                          size="xsmall"
                          mode="ghost"
                          variant="neutral"
                          disabled={busy}
                          onClick={() => void openItem(item)}
                        >
                          {item.title || item.externalId}
                        </Button>
                        <div className="text-micro text-text-soft-400">
                          {item.brand || '未标注品牌'} · {item.price || '价格未标注'}{' '}
                          {item.currency}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {monitors.find((monitor) => monitor.id === item.monitorId)
                          ?.name ?? item.monitorId}
                      </td>
                      <td className="px-3 py-2">{item.favouriteCount ?? '—'}</td>
                      <td className="px-3 py-2">
                        {AVAILABILITY_LABELS[item.availabilityStatus]}
                      </td>
                      <td className="px-3 py-2">{formatTime(item.collectedAt)}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-nowrap items-center gap-1">
                          <PluginRowAction
                            label={item.starred ? '取消收藏' : '收藏商品'}
                            icon={
                              item.starred ? (
                                <UnstarIcon className="size-3.5" />
                              ) : (
                                <StarOutlineIcon className="size-3.5" />
                              )
                            }
                            disabled={busy}
                            onClick={() =>
                              void mutate(() =>
                                vintedMonitorApi.starItem(item.id, !item.starred),
                              )
                            }
                          />
                          <PluginRowAction
                            label="删除归档商品"
                            icon={<DeleteIcon className="size-3.5" />}
                            variant="error"
                            disabled={busy}
                            onClick={() => {
                              setError(null)
                              setDialog({ kind: 'remove-item', item })
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {reading && (
              <div className="p-3 text-secondary text-text-sub-600" role="status">
                正在读取商品归档
              </div>
            )}
            {!reading && !readError && !items.length && loaded && (
              <div className="p-5">
                <EmptyState title="没有匹配的商品" />
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 py-2">
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              disabled={page === 0 || busy || reading || !!readError}
              onClick={() => {
                setSelection([])
                setPage((value) => value - 1)
              }}
            >
              上一页
            </Button>
            <span className="text-secondary text-text-sub-600">第 {page + 1} 页</span>
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              disabled={(page + 1) * 20 >= total || busy || reading || !!readError}
              onClick={() => {
                setSelection([])
                setPage((value) => value + 1)
              }}
            >
              下一页
            </Button>
          </div>
        </section>
      </PluginWorkspace>
      {dialog?.kind === 'monitor' && (
        <MonitorDialog
          value={dialog.value}
          proxies={proxies}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null)
            void refresh()
          }}
        />
      )}
      {dialog?.kind === 'proxy' && (
        <ProxyDialog
          value={dialog.value}
          proxies={proxies}
          defaultProxyId={defaultProxyId}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null)
            void refresh()
          }}
        />
      )}
      {dialog?.kind === 'runs' && (
        <RunDialog monitor={dialog.monitor} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'item' && (
        <ItemDialog
          item={dialog.value}
          canImages={canImages}
          canAi={canAi}
          imageLoader={imageLoader}
          onClose={() => setDialog(null)}
          onChanged={() => {
            setDialog(null)
            void refresh()
          }}
          onHandoff={(photos) =>
            setDialog({ kind: 'handoff', handoffs: [itemHandoff(dialog.value, photos)] })
          }
          onHistory={() => setDialog({ kind: 'history', item: dialog.value })}
        />
      )}
      {dialog?.kind === 'handoff' && (
        <Modal open size="lg" title="生成商品场景" onClose={() => setDialog(null)}>
          {dialog.handoffs.length > 1 && (
            <p className="text-secondary text-text-sub-600">
              当前商品：{dialog.handoffs[0]?.title} · 剩余 {dialog.handoffs.length} 件
            </p>
          )}
          <AiImagePage
            key={dialog.handoffs[0]?.source?.itemId}
            embedded
            onManage={onManage}
            handoff={dialog.handoffs[0]}
            loadVintedImage={imageLoader}
            onHandoffConsumed={(record) => {
              setDialog((current) => {
                if (current !== dialog) return current
                const remaining = current.handoffs.slice(1)
                return record && remaining.length
                  ? { kind: 'handoff', handoffs: remaining }
                  : null
              })
            }}
          />
        </Modal>
      )}
      {dialog?.kind === 'history' && (
        <SourceImageHistoryDialog
          onManage={onManage}
          onClose={() => setDialog(null)}
          source={{
            pluginId: VINTED_PLUGIN_ID,
            itemId: dialog.item.id,
            title: dialog.item.title,
            url: dialog.item.url,
          }}
        />
      )}
      {dialog?.kind === 'remove-monitor' && (
        <AlertModal
          open
          status="error"
          title="删除监控"
          description={
            error ?? `删除「${dialog.monitor.name}」？归档商品与运行记录会保留。`
          }
          confirmLabel="删除监控"
          isLoading={busy}
          onOpenChange={(open) => {
            if (!open && !operation.current) {
              setError(null)
              setDialog(null)
            }
          }}
          onConfirm={async () => {
            if (
              await mutate(async () => {
                const { removed } = await vintedMonitorApi.removeMonitor(
                  dialog.monitor.id,
                )
                toast.ok(removed ? '监控已删除' : '监控已不存在')
              })
            ) {
              if (filters.monitorId === dialog.monitor.id) filterUpdate({ monitorId: '' })
              setDialog(null)
            }
          }}
        />
      )}
      {dialog?.kind === 'remove-item' && (
        <AlertModal
          open
          status="error"
          title="删除商品归档"
          description={error ?? `删除「${dialog.item.title}」归档？不会影响原平台商品。`}
          confirmLabel="删除归档"
          isLoading={busy}
          onOpenChange={(open) => {
            if (!open && !operation.current) {
              setError(null)
              setDialog(null)
            }
          }}
          onConfirm={async () => {
            if (
              await mutate(async () => {
                const { removed } = await vintedMonitorApi.removeItem(dialog.item.id)
                toast.ok(removed ? '商品归档已删除' : '商品归档已不存在')
              })
            ) {
              setSelection((current) => current.filter((id) => id !== dialog.item.id))
              setDialog(null)
            }
          }}
        />
      )}
    </>
  )
}

function MonitorDialog({
  value,
  proxies,
  onClose,
  onSaved,
}: {
  value: Monitor | null
  proxies: MonitorProxy[]
  onClose: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<MonitorInput>(() =>
    value
      ? {
          id: value.id,
          name: value.name,
          searchUrl: value.searchUrl,
          proxyId: value.proxyId,
          intervalMinutes: value.intervalMinutes,
          maxPages: value.maxPages,
          perPage: value.perPage,
          enabled: value.enabled,
        }
      : { ...blankMonitor },
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [inspected, setInspected] = useState<string | null>(null)
  async function inspect() {
    setBusy(true)
    setError(null)
    setInspected(null)
    try {
      const result = await vintedMonitorApi.inspectUrl(draft.searchUrl.trim())
      setInspected(`${monitorKindLabel(result.kind)} · ${result.host}`)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  async function save() {
    setBusy(true)
    setError(null)
    try {
      await vintedMonitorApi.saveMonitor({
        ...draft,
        name: draft.name.trim(),
        searchUrl: draft.searchUrl.trim(),
      })
      onSaved()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open title={value ? '编辑监控' : '新建监控'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Input
          label="名称"
          inputSize="xsmall"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <Input
          label="Vinted 搜索或衣柜 URL"
          inputSize="xsmall"
          value={draft.searchUrl}
          disabled={busy}
          onChange={(event) => {
            setDraft({ ...draft, searchUrl: event.target.value })
            setInspected(null)
          }}
        />
        <div className="flex items-center gap-2">
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            disabled={busy || !draft.searchUrl.trim()}
            onClick={() => void inspect()}
          >
            检查链接
          </Button>
          {inspected && (
            <span className="text-secondary text-text-sub-600">{inspected}</span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Input
            label="间隔（分钟）"
            inputSize="xsmall"
            type="number"
            value={String(draft.intervalMinutes)}
            onChange={(event) =>
              setDraft({ ...draft, intervalMinutes: Number(event.target.value) })
            }
          />
          <Input
            label="最多页数"
            inputSize="xsmall"
            type="number"
            value={String(draft.maxPages)}
            onChange={(event) =>
              setDraft({ ...draft, maxPages: Number(event.target.value) })
            }
          />
          <Input
            label="每页数量"
            inputSize="xsmall"
            type="number"
            value={String(draft.perPage)}
            onChange={(event) =>
              setDraft({ ...draft, perPage: Number(event.target.value) })
            }
          />
        </div>
        <Select
          size="xsmall"
          label="采集代理"
          value={draft.proxyId ?? ''}
          options={[
            { value: '', label: '继承默认代理' },
            ...proxies.map((proxy) => ({
              value: proxy.id,
              label: `${proxy.name} · ${proxy.enabled ? '启用' : '停用'}`,
            })),
          ]}
          onChange={(value) => setDraft({ ...draft, proxyId: value || null })}
        />
        <Checkbox
          checked={draft.enabled}
          label="启用定时采集"
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button size="xsmall" mode="ghost" variant="neutral" onClick={onClose}>
            取消
          </Button>
          <Button size="xsmall" disabled={busy} onClick={() => void save()}>
            保存
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function ProxyDialog({
  value,
  proxies,
  defaultProxyId,
  onClose,
  onSaved,
}: {
  value: MonitorProxy | null
  proxies: MonitorProxy[]
  defaultProxyId: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const [editing, setEditing] = useState<MonitorProxy | null>(value)
  const [draft, setDraft] = useState<ProxyInput>(() =>
    value
      ? {
          id: value.id,
          name: value.name,
          scheme: value.scheme,
          host: value.host,
          port: value.port,
          username: value.username,
          enabled: value.enabled,
        }
      : { ...blankProxy },
  )
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [deleting, setDeleting] = useState<MonitorProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  function selectProxy(proxy: MonitorProxy | null) {
    setEditing(proxy)
    setDraft(
      proxy
        ? {
            id: proxy.id,
            name: proxy.name,
            scheme: proxy.scheme,
            host: proxy.host,
            port: proxy.port,
            username: proxy.username,
            enabled: proxy.enabled,
          }
        : { ...blankProxy },
    )
    setPassword('')
    setClearPassword(false)
    setError(null)
  }
  async function save() {
    setBusy(true)
    setError(null)
    try {
      await vintedMonitorApi.saveProxy({
        ...draft,
        name: draft.name.trim(),
        host: draft.host.trim(),
        ...(clearPassword ? { password: '' } : password || !editing ? { password } : {}),
      })
      toast.saved('采集代理已保存')
      onSaved()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  async function remove(proxy: MonitorProxy) {
    setBusy(true)
    setError(null)
    try {
      const { removed } = await vintedMonitorApi.removeProxy(proxy.id)
      toast.ok(removed ? '采集代理已删除' : '采集代理已不存在')
      setDeleting(null)
      selectProxy(null)
      onSaved()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  async function makeDefault(proxy: MonitorProxy | null) {
    setBusy(true)
    setError(null)
    try {
      await vintedMonitorApi.setDefaultProxy(proxy?.id ?? null)
      toast.saved(proxy ? '默认采集代理已保存' : '已改为继承应用网络设置')
      onSaved()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Modal
        open
        size="lg"
        title={editing ? '编辑采集代理' : '新增采集代理'}
        onClose={onClose}
      >
        <div className="grid gap-4 md:grid-cols-[minmax(220px,1fr)_minmax(280px,1fr)]">
          <div className="flex flex-col gap-2">
            <div className="text-body font-medium text-text-strong-950">已配置代理</div>
            {proxies.map((proxy) => (
              <div
                key={proxy.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-stroke-soft-200 p-2"
              >
                <Button
                  size="xsmall"
                  mode="ghost"
                  variant="neutral"
                  onClick={() => selectProxy(proxy)}
                >
                  {proxy.name}
                </Button>
                <div className="flex gap-1">
                  <Button
                    size="xsmall"
                    mode="ghost"
                    variant="neutral"
                    disabled={busy || !proxy.enabled || defaultProxyId === proxy.id}
                    onClick={() => void makeDefault(proxy)}
                  >
                    {defaultProxyId === proxy.id ? '默认' : '设默认'}
                  </Button>
                  <Button
                    size="xsmall"
                    mode="ghost"
                    variant="neutral"
                    disabled={busy || defaultProxyId === proxy.id}
                    onClick={() => setDeleting(proxy)}
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
            {!proxies.length && (
              <span className="text-secondary text-text-soft-400">暂无代理</span>
            )}
            {defaultProxyId && (
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                disabled={busy}
                onClick={() => void makeDefault(null)}
              >
                继承应用网络设置
              </Button>
            )}
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              onClick={() => selectProxy(null)}
            >
              新增代理
            </Button>
          </div>
          <div className="flex flex-col gap-3">
            <Input
              label="名称"
              inputSize="xsmall"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <div className="grid grid-cols-[100px_1fr_90px] gap-2">
              <Select
                size="xsmall"
                label="协议"
                value={draft.scheme}
                options={['http', 'https', 'socks5', 'socks5h'].map((entry) => ({
                  value: entry,
                  label: entry,
                }))}
                onChange={(next) =>
                  setDraft({ ...draft, scheme: next as ProxyInput['scheme'] })
                }
              />
              <Input
                label="主机"
                inputSize="xsmall"
                value={draft.host}
                onChange={(event) => setDraft({ ...draft, host: event.target.value })}
              />
              <Input
                label="端口"
                inputSize="xsmall"
                type="number"
                value={String(draft.port)}
                onChange={(event) =>
                  setDraft({ ...draft, port: Number(event.target.value) })
                }
              />
            </div>
            <Input
              label="用户名"
              inputSize="xsmall"
              value={draft.username}
              onChange={(event) => setDraft({ ...draft, username: event.target.value })}
            />
            <Input
              label="密码"
              inputSize="xsmall"
              type="password"
              value={password}
              placeholder={editing?.hasPassword ? '留空保持原密码' : ''}
              disabled={clearPassword}
              onChange={(event) => setPassword(event.target.value)}
            />
            {editing?.hasPassword && (
              <Checkbox
                label="清除已保存的密码"
                checked={clearPassword}
                onChange={(event) => setClearPassword(event.target.checked)}
              />
            )}
            <Checkbox
              label="启用代理"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
            {error && (
              <Alert status="error" variant="lighter">
                {error}
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              <Button size="xsmall" mode="ghost" variant="neutral" onClick={onClose}>
                取消
              </Button>
              <Button size="xsmall" disabled={busy} onClick={() => void save()}>
                保存
              </Button>
            </div>
          </div>
        </div>
      </Modal>
      {deleting && (
        <AlertModal
          open
          status="error"
          title="删除采集代理"
          description={error ?? `删除「${deleting.name}」？`}
          confirmLabel="删除代理"
          isLoading={busy}
          onOpenChange={(open) => {
            if (!open && !busy) {
              setDeleting(null)
              setError(null)
            }
          }}
          onConfirm={() => void remove(deleting)}
        />
      )}
    </>
  )
}

function RunDialog({ monitor, onClose }: { monitor: Monitor; onClose: () => void }) {
  const [result, setResult] = useState<Page<Run> | null>(null)
  const [page, setPage] = useState(0)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    async function read() {
      try {
        const next = await vintedMonitorApi.runs(monitor.id, { page, pageSize: 20 })
        if (!live) return
        setResult(next)
        setError(null)
        if (next.items.some(({ status }) => status === 'running'))
          timer = setTimeout(() => void read(), 3000)
      } catch (cause) {
        if (live) setError(message(cause))
      }
    }
    void read()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [monitor.id, page, revision])
  const current = result?.page === page ? result : null
  return (
    <Modal open size="lg" title={`运行历史 · ${monitor.name}`} onClose={onClose}>
      <div className="flex flex-col gap-2">
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        {current?.items.map((run) => (
          <div
            key={run.id}
            className="flex flex-col gap-1 border-b border-stroke-soft-200 py-2"
          >
            <span>
              {RUN_STATUS_LABELS[run.status]} · {formatTime(run.startedAt)}
            </span>
            <span className="text-secondary text-text-sub-600">
              {run.pages} 页 · 发现 {run.discovered} · 新增 {run.inserted} · 更新{' '}
              {run.updated} · 跳过 {run.skipped} · 失败 {run.failed} · 卖家失败{' '}
              {run.userFailed}
            </span>
            {run.finishedAt && (
              <span className="text-secondary text-text-sub-600">
                结束于 {formatTime(run.finishedAt)}
              </span>
            )}
            {run.truncated && (
              <span className="text-secondary text-text-sub-600">
                达到分页上限，结果不完整
              </span>
            )}
            {run.error && (
              <Alert status="warning" variant="lighter">
                {run.error}
              </Alert>
            )}
          </div>
        ))}
        {!current && !error && <p role="status">正在读取运行记录</p>}
        {current?.total === 0 && !error && <EmptyState title="暂无运行记录" />}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="xsmall"
            mode="ghost"
            variant="neutral"
            onClick={() => setRevision((value) => value + 1)}
          >
            刷新
          </Button>
          <Button
            size="xsmall"
            mode="ghost"
            variant="neutral"
            disabled={page === 0}
            onClick={() => setPage((value) => value - 1)}
          >
            上一页
          </Button>
          <span className="text-secondary text-text-sub-600">第 {page + 1} 页</span>
          <Button
            size="xsmall"
            mode="ghost"
            variant="neutral"
            disabled={!current || page + 1 >= current.totalPages}
            onClick={() => setPage((value) => value + 1)}
          >
            下一页
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function ItemDialog({
  item,
  canImages,
  canAi,
  imageLoader,
  onClose,
  onChanged,
  onHandoff,
  onHistory,
}: {
  item: Item
  canImages: boolean
  canAi: boolean
  imageLoader: (itemId: string, url: string, signal: AbortSignal) => Promise<Blob>
  onClose: () => void
  onChanged: () => void
  onHandoff: (photos: string[]) => void
  onHistory: () => void
}) {
  const [status, setStatus] = useState<AvailabilityStatus>(
    item.availabilityStatus === 'unknown' ? 'pending' : item.availabilityStatus,
  )
  const [note, setNote] = useState(item.statusNote ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const photos = itemReferencePhotos(item)
  const [picked, setPicked] = useState(() => photos.slice(0, 1))
  const [viewing, setViewing] = useState(() => photos[0])
  const sellerUrl = item.sellerProfile?.profileUrl
  const runAction = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  async function review() {
    setBusy(true)
    setError(null)
    try {
      await vintedMonitorApi.reviewItem(
        item.id,
        status === 'unknown' ? 'pending' : status,
        note.trim(),
      )
      onChanged()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      size="lg"
      title={item.title || item.externalId}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <div className="grid gap-3 md:grid-cols-[1fr_260px]">
        <div className="flex flex-col gap-2">
          <div className="text-secondary text-text-sub-600">
            {item.brand || '未标注品牌'} · {item.size || '尺码未标注'} ·{' '}
            {item.condition || '成色未标注'}
          </div>
          <div className="text-secondary text-text-sub-600">
            {item.price || '价格未标注'} {item.currency} · 卖家 {item.seller || '未知'}
          </div>
          {typeof item.detail.description === 'string' &&
            item.detail.description.trim() && (
              <p className="whitespace-pre-wrap break-words text-body text-text-sub-600">
                {item.detail.description}
              </p>
            )}
          {canImages && viewing && (
            <ControlledImage
              key={viewing}
              itemId={item.id}
              url={viewing}
              load={imageLoader}
            />
          )}
          {canImages && photos.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label="图库与参考图"
            >
              {photos.map((url, index) => (
                <div key={url} className="flex items-center gap-1">
                  <Button
                    size="xsmall"
                    mode={viewing === url ? 'stroke' : 'ghost'}
                    variant="neutral"
                    onClick={() => setViewing(url)}
                  >
                    图 {index + 1}
                  </Button>
                  {canAi && (
                    <Checkbox
                      label={`选择参考图 ${index + 1}`}
                      checked={picked.includes(url)}
                      disabled={busy || (!picked.includes(url) && picked.length >= 6)}
                      onChange={(event) => {
                        const checked = event.target.checked
                        setPicked((current) =>
                          checked
                            ? [...current, url]
                            : current.filter((entry) => entry !== url),
                        )
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
          {!canImages && (
            <Alert status="warning" variant="lighter">
              当前插件未提供图片传输方法。
            </Alert>
          )}
          {error && (
            <Alert status="error" variant="lighter">
              {error}
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="xsmall"
              disabled={busy || !canImages || !canAi || !picked.length}
              onClick={() => onHandoff(picked)}
            >
              生成商品场景
            </Button>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              disabled={busy || !canAi}
              onClick={onHistory}
            >
              生图历史
            </Button>
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              disabled={busy || !item.url}
              onClick={() =>
                void runAction(async () => {
                  await clip.write(item.url)
                  toast.ok('商品链接已复制')
                })
              }
            >
              复制商品链接
            </Button>
            {item.url && (
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                disabled={busy}
                onClick={() =>
                  void runAction(() => invoke('external_url_open', { url: item.url }))
                }
              >
                查看原商品
              </Button>
            )}
            {sellerUrl && (
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                disabled={busy}
                onClick={() =>
                  void runAction(() => invoke('external_url_open', { url: sellerUrl }))
                }
              >
                查看卖家
              </Button>
            )}
            {item.userId && (
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={busy}
                onClick={() =>
                  void runAction(async () => {
                    const { created } = await vintedMonitorApi.monitorSeller(item.id)
                    toast.ok(created ? '已创建卖家监控' : '卖家监控已存在')
                    onChanged()
                  })
                }
              >
                监控卖家
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <Select
            size="xsmall"
            label="人工状态"
            value={status}
            options={Object.entries(AVAILABILITY_LABELS)
              .filter(([value]) => value !== 'unknown')
              .map(([value, label]) => ({ value, label }))}
            onChange={(value) => setStatus(value as AvailabilityStatus)}
          />
          <Textarea
            label="复核备注"
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button size="xsmall" disabled={busy} onClick={() => void review()}>
            保存复核
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function ControlledImage({
  itemId,
  url,
  load,
}: {
  itemId: string
  url: string
  load: (itemId: string, url: string, signal: AbortSignal) => Promise<Blob>
}) {
  const [source, setSource] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | null = null
    void load(itemId, url, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setSource(objectUrl)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attempt, itemId, load, url])
  if (error)
    return (
      <Button
        size="xsmall"
        mode="stroke"
        variant="neutral"
        onClick={() => {
          setError(false)
          setSource(null)
          setAttempt((value) => value + 1)
        }}
      >
        图片加载失败，重试
      </Button>
    )
  return source ? (
    <img
      src={source}
      alt=""
      className="h-[224px] w-full rounded-control border border-stroke-soft-200 object-contain"
      referrerPolicy="no-referrer"
      onError={() => setError(true)}
    />
  ) : (
    <div
      className="h-[224px] w-full rounded-control border border-stroke-soft-200 bg-bg-weak-50"
      aria-label="图片加载中"
    />
  )
}
