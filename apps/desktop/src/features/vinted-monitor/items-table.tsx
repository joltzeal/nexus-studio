import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  History,
  Loader2,
  Radar,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Trash2,
  X,
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
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
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
import { SourceImageHistoryDialog } from '@/features/ai-image/source-image-history-dialog'
import { sendToAiImage } from '@/lib/page-handoff'
import { listItems, listMonitors, monitorSeller, removeItem, starItem } from './api'
import { VintedExternalLink } from './external-link'
import { itemAiHandoff, vintedItemSource } from './item-ai-handoff'
import { AvailabilityBadge, ItemDetailSheet } from './item-detail-sheet'
import {
  EMPTY_FILTERS,
  FAVOURITE_OPERATORS,
  itemFilterParams,
  nextFavouriteOrder,
  sourceCountry,
  type FilterDraft,
} from './item-filters'
import { ItemImage } from './item-image'
import { vintedImageCache } from './image-cache'
import { SellerPopover } from './seller-profile'
import { ColumnMenu, TablePager } from './table-controls'
import {
  AVAILABILITY_LABELS,
  formatTime,
  message,
  priceText,
  type Item,
  type ItemFilters,
  type ItemList,
  type ItemOrder,
  type ItemSummary,
  type Monitor,
} from './types'

const COLUMNS = [
  { id: 'starred', label: '星标' },
  { id: 'availability', label: '核查状态' },
  { id: 'image', label: '图片' },
  { id: 'title', label: '标题' },
  { id: 'price', label: '价格' },
  { id: 'favourite', label: '点赞数' },
  { id: 'views', label: '浏览数' },
  { id: 'seller', label: '卖家' },
  { id: 'country', label: '来源国家' },
  { id: 'external', label: '来源商品 ID' },
  { id: 'collected', label: '采集时间' },
  { id: 'url', label: '商品链接' },
]
const ALL = '__all__'

export function VintedItemsTable({
  initialMonitorId = '',
  aiImageReady,
  refreshKey = 0,
}: {
  initialMonitorId?: string
  aiImageReady: boolean
  refreshKey?: number
}) {
  const [draft, setDraft] = useState<FilterDraft>(() => ({
    ...EMPTY_FILTERS,
    monitorId: initialMonitorId,
  }))
  const [filters, setFilters] = useState<ItemFilters>(() =>
    initialMonitorId ? { monitorId: initialMonitorId } : {},
  )
  const [filterError, setFilterError] = useState<string | null>(null)
  const [order, setOrder] = useState<ItemOrder>('collected_desc')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(20)
  const [nonce, setNonce] = useState(0)
  const [hidden, setHidden] = useState<string[]>([])
  const [state, setState] = useState<{
    key: string
    data: ItemList | null
    error: string | null
  } | null>(null)
  const [monitors, setMonitors] = useState<Monitor[]>([])
  const [monitorError, setMonitorError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ id: string; preview: boolean } | null>(null)
  const [history, setHistory] = useState<ItemSummary | null>(null)
  const [removing, setRemoving] = useState<ItemSummary | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const key = JSON.stringify({ ...filters, order, page, pageSize, nonce, refreshKey })
  const current = state?.key === key ? state : null
  const rows = current?.data?.items ?? []
  useEffect(() => {
    let active = true
    void listItems({ ...filters, order, page, pageSize }).then(
      (data) => {
        if (!active) return
        const last = Math.max(0, Math.ceil(data.total / pageSize) - 1)
        if (page > last) {
          setPage(last)
          return
        }
        setState({ key, data, error: null })
      },
      (cause: unknown) => {
        if (active) setState({ key, data: null, error: message(cause) })
      },
    )
    return () => {
      active = false
    }
  }, [key, filters, order, page, pageSize])
  useEffect(() => {
    let active = true
    void listMonitors().then(
      (data) => {
        if (active) {
          setMonitors(data.items)
          setMonitorError(null)
        }
      },
      (cause: unknown) => {
        if (active) setMonitorError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [nonce, refreshKey])
  useEffect(() => () => vintedImageCache.clearUnused(), [])
  function patch(next: Partial<FilterDraft>) {
    setDraft((old) => ({ ...old, ...next }))
  }
  function search() {
    try {
      const next = itemFilterParams(draft)
      setFilters(next)
      setPage(0)
      setNonce((value) => value + 1)
      setFilterError(null)
    } catch (cause) {
      setFilterError(message(cause))
    }
  }
  function reset() {
    setDraft({ ...EMPTY_FILTERS })
    setFilters({})
    setPage(0)
    setFilterError(null)
  }
  async function toggleStar(item: ItemSummary) {
    if (busyId) return
    setBusyId(item.id)
    try {
      await starItem(item.id, !item.starred)
      setNonce((value) => value + 1)
    } catch (cause) {
      toast.error(message(cause))
    } finally {
      setBusyId(null)
    }
  }
  async function addSeller(item: ItemSummary) {
    if (busyId) return
    setBusyId(item.id)
    try {
      const result = await monitorSeller(item.id)
      toast.success(
        result.created
          ? '卖家监控已创建，沿用来源监控的代理和间隔'
          : result.monitor.enabled
            ? '已复用现有卖家监控'
            : '该卖家监控已暂停，请在监控列表中启用',
      )
      setNonce((value) => value + 1)
    } catch (cause) {
      toast.error(message(cause))
    } finally {
      setBusyId(null)
    }
  }
  async function drop() {
    if (!removing || busyId) return
    setBusyId(removing.id)
    setRemoveError(null)
    try {
      await removeItem(removing.id)
      if (detail?.id === removing.id) setDetail(null)
      setRemoving(null)
      setNonce((value) => value + 1)
      toast.success('商品已删除，后续监控不再采集该商品')
    } catch (cause) {
      setRemoveError(message(cause))
    } finally {
      setBusyId(null)
    }
  }
  function generate(item: Item, images: string[]) {
    if (!aiImageReady || images.length === 0) return
    sendToAiImage(itemAiHandoff(item, images))
    setDetail(null)
  }
  const visible = COLUMNS.filter((column) => !hidden.includes(column.id))
  const SortIcon =
    order === 'favourite_asc'
      ? ArrowUp
      : order === 'favourite_desc'
        ? ArrowDown
        : ArrowUpDown
  const nullableOp =
    draft.favouriteCountOp === 'isNull' || draft.favouriteCountOp === 'notNull'
  return (
    <div className="vinted-body">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          search()
        }}
      >
        <FieldGroup className="vinted-filter-grid">
          <Field>
            <FieldLabel htmlFor="vinted-item-monitor">URL 监控</FieldLabel>
            <LabeledSelect
              id="vinted-item-monitor"
              ariaLabel="URL 监控筛选"
              value={draft.monitorId || ALL}
              options={[
                { value: ALL, label: '全部监控' },
                ...monitors.map((monitor) => ({
                  value: monitor.id,
                  label: monitor.name,
                })),
                ...(draft.monitorId &&
                !monitors.some((entry) => entry.id === draft.monitorId)
                  ? [{ value: draft.monitorId, label: '所选监控已不可用' }]
                  : []),
              ]}
              onValueChange={(value) => patch({ monitorId: value === ALL ? '' : value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="vinted-item-availability">核查状态</FieldLabel>
            <LabeledSelect
              id="vinted-item-availability"
              ariaLabel="核查状态筛选"
              value={draft.availabilityStatus || ALL}
              options={[
                { value: ALL, label: '全部状态' },
                ...Object.entries(AVAILABILITY_LABELS).map(([value, label]) => ({
                  value,
                  label,
                })),
              ]}
              onValueChange={(value) =>
                patch({ availabilityStatus: value === ALL ? '' : value })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="vinted-item-starred">星标</FieldLabel>
            <LabeledSelect
              id="vinted-item-starred"
              ariaLabel="星标筛选"
              value={draft.starred || ALL}
              options={[
                { value: ALL, label: '全部商品' },
                { value: 'true', label: '已加星标' },
                { value: 'false', label: '未加星标' },
              ]}
              onValueChange={(value) => patch({ starred: value === ALL ? '' : value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="vinted-item-id">来源商品 ID</FieldLabel>
            <Input
              id="vinted-item-id"
              value={draft.externalId}
              maxLength={32}
              placeholder="商品 ID"
              onChange={(event) => patch({ externalId: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="vinted-item-keyword">关键词</FieldLabel>
            <Input
              id="vinted-item-keyword"
              value={draft.keyword}
              maxLength={100}
              placeholder="标题、品牌或卖家"
              onChange={(event) => patch({ keyword: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="vinted-item-favourite">点赞数</FieldLabel>
            <div className="flex gap-1">
              <LabeledSelect
                id="vinted-item-favourite"
                ariaLabel="点赞数条件"
                value={draft.favouriteCountOp || ALL}
                options={[{ value: ALL, label: '不限' }, ...FAVOURITE_OPERATORS]}
                onValueChange={(value) =>
                  patch({ favouriteCountOp: value === ALL ? '' : value })
                }
              />
              {draft.favouriteCountOp && !nullableOp ? (
                <Input
                  className="min-w-16"
                  aria-label={
                    draft.favouriteCountOp === 'between' ? '点赞数下限' : '点赞数数值'
                  }
                  type="number"
                  min={0}
                  step={1}
                  value={draft.favouriteCount}
                  onChange={(event) => patch({ favouriteCount: event.target.value })}
                />
              ) : null}
              {draft.favouriteCountOp === 'between' ? (
                <Input
                  className="min-w-16"
                  aria-label="点赞数上限"
                  type="number"
                  min={0}
                  step={1}
                  value={draft.favouriteCountEnd}
                  onChange={(event) => patch({ favouriteCountEnd: event.target.value })}
                />
              ) : null}
            </div>
          </Field>
        </FieldGroup>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              <Search data-icon="inline-start" />
              查询商品
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={reset}>
              <X data-icon="inline-start" />
              清除筛选
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                vintedImageCache.clearUnused()
                setNonce((value) => value + 1)
              }}
            >
              <RefreshCw data-icon="inline-start" />
              刷新商品
            </Button>
            <ColumnMenu columns={COLUMNS} hidden={hidden} onChange={setHidden} />
          </div>
        </div>
      </form>
      {filterError ? <FieldError role="alert">{filterError}</FieldError> : null}
      {monitorError ? (
        <FieldError role="alert">
          监控筛选列表加载失败：{monitorError}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setNonce((value) => value + 1)}
          >
            重试
          </Button>
        </FieldError>
      ) : null}
      {current === null ? (
        <div className="vinted-skeleton">
          {[1, 2, 3, 4].map((value) => (
            <Skeleton key={value} className="h-14 w-full" />
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
            <EmptyTitle>
              {Object.keys(filters).length ? '没有匹配的商品' : '还没有采集到商品'}
            </EmptyTitle>
            <EmptyDescription>
              {Object.keys(filters).length
                ? '调整或清除筛选条件。'
                : '先在 URL 监控中新增任务并运行采集。'}
            </EmptyDescription>
          </EmptyHeader>
          {Object.keys(filters).length ? (
            <Button size="sm" variant="outline" onClick={reset}>
              清除筛选
            </Button>
          ) : null}
        </Empty>
      ) : (
        <div className="vinted-table-scroll vinted-product-table">
          <Table>
            <TableHeader>
              <TableRow>
                {visible.map((column) => (
                  <TableHead
                    key={column.id}
                    aria-sort={
                      column.id === 'favourite'
                        ? order === 'favourite_asc'
                          ? 'ascending'
                          : order === 'favourite_desc'
                            ? 'descending'
                            : 'none'
                        : undefined
                    }
                  >
                    {column.id === 'favourite' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`点赞数排序：${order === 'collected_desc' ? '未排序' : order === 'favourite_asc' ? '升序' : '降序'}`}
                        onClick={() => {
                          setOrder(nextFavouriteOrder(order))
                          setPage(0)
                        }}
                      >
                        点赞数
                        <SortIcon data-icon="inline-end" />
                      </Button>
                    ) : (
                      column.label
                    )}
                  </TableHead>
                ))}
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((item) => {
                const matching = monitors.filter(
                  (monitor) =>
                    monitor.host.replace(/^www\./, '') ===
                      item.domain.replace(/^www\./, '') &&
                    !!item.userId &&
                    monitor.userId === item.userId,
                )
                const existing =
                  matching.find((monitor) => monitor.enabled) ?? matching[0]
                const cells: Record<string, ReactNode> = {
                  starred: (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={!!busyId}
                      aria-label={`${item.starred ? '取消星标' : '添加星标'} ${item.title}`}
                      aria-pressed={item.starred}
                      onClick={() => void toggleStar(item)}
                    >
                      <Star fill={item.starred ? 'currentColor' : 'none'} />
                    </Button>
                  ),
                  availability: <AvailabilityBadge item={item} />,
                  image: item.imageUrl ? (
                    <button
                      type="button"
                      className="vinted-product-thumb"
                      aria-label={`预览图片 ${item.title}`}
                      onClick={() => setDetail({ id: item.id, preview: true })}
                    >
                      <ItemImage itemId={item.id} url={item.imageUrl} alt={item.title} />
                    </button>
                  ) : (
                    '—'
                  ),
                  title: (
                    <button
                      type="button"
                      className="vinted-text-link block max-w-64 truncate"
                      title={item.title}
                      onClick={() => setDetail({ id: item.id, preview: false })}
                    >
                      {item.title || '未命名商品'}
                    </button>
                  ),
                  price: priceText(item),
                  favourite: item.favouriteCount ?? '—',
                  views: item.viewCount ?? '—',
                  seller: (
                    <div className="flex flex-col items-start gap-1">
                      {item.sellerProfile ? (
                        <SellerPopover seller={item.sellerProfile} itemId={item.id} />
                      ) : (
                        item.seller || item.userId || '—'
                      )}
                      {item.userId ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!!busyId || !!existing || !!monitorError}
                          aria-label={`监控卖家 ${item.userId}`}
                          title={
                            existing
                              ? '请在 URL 监控中管理该卖家监控'
                              : '继承来源监控的代理和执行间隔'
                          }
                          onClick={() => void addSeller(item)}
                        >
                          <Radar data-icon="inline-start" />
                          {existing
                            ? existing.enabled
                              ? '已监控'
                              : '监控已暂停'
                            : '监控卖家'}
                        </Button>
                      ) : null}
                    </div>
                  ),
                  country: sourceCountry(item.domain),
                  external: item.externalId,
                  collected: (
                    <time
                      dateTime={item.collectedAt}
                      title={formatTime(item.collectedAt)}
                    >
                      {formatTime(item.collectedAt)}
                    </time>
                  ),
                  url: (
                    <VintedExternalLink href={item.url} fallback="—">
                      查看原商品
                    </VintedExternalLink>
                  ),
                }
                return (
                  <TableRow key={item.id}>
                    {visible.map((column) => (
                      <TableCell key={column.id}>{cells[column.id]}</TableCell>
                    ))}
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={!aiImageReady}
                          aria-label={`生成商品场景 ${item.title}`}
                          title={
                            aiImageReady
                              ? '选择图片并生成商品场景'
                              : '请先启用 AI 生图插件'
                          }
                          onClick={() => setDetail({ id: item.id, preview: true })}
                        >
                          <Sparkles />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={!aiImageReady}
                          aria-label={`商品生成记录 ${item.title}`}
                          title="商品生成记录"
                          onClick={() => setHistory(item)}
                        >
                          <History />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={!!busyId}
                          aria-label={`删除商品 ${item.title}`}
                          title="删除并停止更新"
                          onClick={() => {
                            setRemoveError(null)
                            setRemoving(item)
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </div>
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
      {detail ? (
        <ItemDetailSheet
          key={detail.id}
          itemId={detail.id}
          preview={detail.preview}
          aiImageReady={aiImageReady}
          onClose={() => setDetail(null)}
          onGenerate={generate}
          onHistory={(item) => {
            setDetail(null)
            setHistory(item)
          }}
          onChanged={() => setNonce((value) => value + 1)}
        />
      ) : null}
      {history ? (
        <SourceImageHistoryDialog
          source={vintedItemSource(history)}
          onClose={() => setHistory(null)}
        />
      ) : null}
      <AlertDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busyId) setRemoving(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除商品</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除「{removing?.title}
              」吗？该商品将从列表移除，后续监控不再采集或更新该商品。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError ? <FieldError role="alert">{removeError}</FieldError> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busyId}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!busyId}
              onClick={(event) => {
                event.preventDefault()
                void drop()
              }}
            >
              {busyId ? <Loader2 className="animate-spin" /> : null}删除并停止更新
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
