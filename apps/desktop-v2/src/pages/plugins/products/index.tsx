import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  AlertModal,
  Button,
  DataList,
  EmptyState,
  Tooltip,
  type DataListColumn,
} from '@proxyshard/shardx-ui-kit'
import {
  PRODUCTS_PLUGIN_ID,
  type Product,
  type ProductPage,
  type ProductQuery,
  type ProductSummary,
} from '@nexus/plugin-contracts/products'
import {
  AI_IMAGE_CAPABILITY,
  AI_IMAGE_PLUGIN_ID,
} from '../../../raccoon/plugins/ai-image/types'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import {
  productApi,
  supportsProduct,
  supportsProductPage,
} from '../../../raccoon/plugins/products/api'
import { productError } from '../../../raccoon/plugins/products/form'
import {
  productTime,
  sourceLabels,
  statusLabels,
} from '../../../raccoon/plugins/products/model'
import { isNativeRaccoon } from '../../../raccoon/runtime'
import { toast } from '../../../shared/model/toast'
import {
  AddIcon,
  ClockIcon,
  DeleteIcon,
  EditIcon,
  RefreshIcon,
  RegenerateIcon,
  UploadIcon,
} from '../../../shared/icons'
import { PluginRowAction } from '../PluginRowAction'
import { ListColumn } from '../../../shared/ui/ListColumn'
import { PageHeader } from '../../../widgets/PageHeader'
import { PluginWorkspace } from '../PluginWorkspace'
import { AiImportDialog } from './AiImportDialog'
import { ImportDialog } from './ImportDialog'
import { Pager } from './Pager'
import { ProductEditor } from './ProductEditor'
import { ProductFilters } from './ProductFilters'
import { ProductImage } from './ProductImage'
import { PublicationHistory } from './PublicationHistory'
import { useDetailNavigation } from '../../../raccoon/plugins/detail-navigation'

type Panel =
  | { kind: 'edit'; product: Product | null }
  | { kind: 'history' | 'remove'; product: ProductSummary }
  | { kind: 'import' | 'ai' }

export function ProductsPage({ onManage }: { onManage: () => void }) {
  const plugin = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === PRODUCTS_PLUGIN_ID),
  )
  const ai = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === AI_IMAGE_PLUGIN_ID),
  )
  const native = isNativeRaccoon()
  if (!native || !supportsProductPage(plugin))
    return (
      <>
        <PageHeader
          title="商品管理"
          actions={
            <Button size="xsmall" mode="stroke" variant="neutral" onClick={onManage}>
              管理插件
            </Button>
          }
        />
        <PluginWorkspace>
          <EmptyState
            title={native ? '商品插件尚不可用' : '请在桌面应用中使用商品管理'}
            hint={
              native
                ? (plugin?.lastError ??
                  '请在插件中心检查运行状态和授权，或更新商品管理插件。')
                : undefined
            }
          />
        </PluginWorkspace>
      </>
    )
  const canImportAi = Boolean(
    plugin?.storageDurable &&
    supportsProduct(plugin, 'importAi') &&
    ai?.enabled &&
    ai.state === 'running' &&
    ai.storageDurable &&
    ai.capabilities.includes(AI_IMAGE_CAPABILITY) &&
    ai.granted.includes(AI_IMAGE_CAPABILITY) &&
    ['image.records.list', 'image.records.get', 'image.file.chunk'].every((method) =>
      ai.methods.includes(method),
    ),
  )
  return (
    <ProductCatalog
      canImportAi={canImportAi}
      storageDurable={plugin?.storageDurable === true}
    />
  )
}

function ProductCatalog({
  canImportAi,
  storageDurable,
}: {
  canImportAi: boolean
  storageDurable: boolean
}) {
  const [query, setQuery] = useState<ProductQuery>({ query: '', page: 1, pageSize: 20 })
  const [loaded, setLoaded] = useState<{
    query: ProductQuery
    data?: ProductPage
    error?: string
  } | null>(null)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [operation, setOperation] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const active = useRef<AbortController | null>(null)
  useDetailNavigation('product', (request) => {
    edit({ id: request.id })
  })
  useEffect(() => () => active.current?.abort(), [])
  useEffect(() => {
    let live = true
    const timer = window.setTimeout(
      () =>
        void productApi
          .list(query)
          .then((data) => {
            if (live) setLoaded({ query, data })
          })
          .catch((cause) => {
            if (live) setLoaded({ query, error: productError(cause) })
          }),
      160,
    )
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [query])

  const current = loaded?.query === query ? loaded : null
  const data = current?.data
  const canWrite = storageDurable && loaded?.data?.storageDurable === true
  const readOnly = !storageDurable || loaded?.data?.storageDurable === false
  const refresh = (firstPage = false) =>
    setQuery((latest) => ({
      ...latest,
      page: firstPage
        ? 1
        : loaded?.query === latest
          ? (loaded.data?.page ?? latest.page)
          : latest.page,
    }))
  const rows = data?.items ?? []

  async function run(
    action: (signal: AbortSignal) => Promise<void>,
    requiresWrite = true,
  ) {
    if (active.current) {
      setError('当前商品操作尚未完成，请完成后重新打开关联记录。')
      return
    }
    if (requiresWrite && !canWrite) return
    const controller = new AbortController()
    active.current = controller
    setOperation(true)
    setError(null)
    try {
      await action(controller.signal)
    } catch (cause) {
      if (!controller.signal.aborted) setError(productError(cause))
    } finally {
      active.current = null
      if (!controller.signal.aborted) setOperation(false)
    }
  }

  function edit(row: Pick<ProductSummary, 'id'>) {
    void run(async (signal) => {
      const product = await productApi.get(row.id)
      if (!signal.aborted) setPanel({ kind: 'edit', product })
    }, false)
  }

  function remove(row: ProductSummary) {
    void run(async (signal) => {
      const removed = await productApi.remove(row)
      if (signal.aborted) return
      setSelected((current) => {
        const next = new Set(current)
        next.delete(row.id)
        return next
      })
      setPanel(null)
      toast.ok(removed ? '商品已删除' : '商品已不存在')
      refresh()
    })
  }

  const columns: DataListColumn<ProductSummary>[] = [
    {
      id: 'product',
      header: '商品',
      width: 'minmax(190px, 2fr)',
      cell: (row) => (
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-10 shrink-0">
            <ProductImage key={row.cover?.id} image={row.cover} />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <Tooltip whenTruncated content={row.name}>
              <strong className="truncate font-medium text-text-strong-950">
                {row.name}
              </strong>
            </Tooltip>
            <Tooltip whenTruncated content={row.title || row.category}>
              <span className="truncate text-micro text-text-sub-600">
                {row.title || row.category || '未填写标题'}
              </span>
            </Tooltip>
          </div>
        </div>
      ),
    },
    {
      id: 'price',
      header: '价格',
      width: 'minmax(80px, .7fr)',
      cell: (row) => (
        <span className="tabular-nums">
          {row.price === null
            ? '未填写'
            : new Intl.NumberFormat('zh-CN', {
                style: 'currency',
                currency: row.currency,
              }).format(row.price)}
        </span>
      ),
    },
    {
      id: 'status',
      header: '准备 / 来源',
      width: 'minmax(108px, 1fr)',
      cell: (row) => (
        <div className="flex flex-col">
          <span>{statusLabels[row.status]}</span>
          <span className="text-micro text-text-sub-600">
            {sourceLabels[row.source.kind]}
          </span>
        </div>
      ),
    },
    {
      id: 'publication',
      header: '发布',
      width: 'minmax(120px, 1fr)',
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span>
            {row.publicationCount ? `已发布 · ${row.publicationCount}` : '未发布'}
          </span>
          {row.latestPublication && (
            <Tooltip whenTruncated content={row.latestPublication.windowName}>
              <span className="truncate text-micro text-text-sub-600">
                {row.latestPublication.windowName}
              </span>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      id: 'updated',
      header: '更新于',
      width: 'minmax(125px, 1fr)',
      cell: (row) => (
        <span className="text-micro tabular-nums text-text-sub-600">
          {productTime(row.updatedAt)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '操作',
      width: '104px',
      cell: (row) => (
        <div className="flex flex-nowrap items-center gap-1">
          <PluginRowAction
            label="编辑商品"
            icon={<EditIcon className="size-3.5" />}
            disabled={!canWrite || operation}
            onClick={() => edit(row)}
          />
          <PluginRowAction
            label="发布历史"
            icon={<ClockIcon className="size-3.5" />}
            onClick={() => setPanel({ kind: 'history', product: row })}
          />
          <PluginRowAction
            label="删除商品"
            icon={<DeleteIcon className="size-3.5" />}
            variant="error"
            disabled={!canWrite || operation}
            onClick={() => {
              setError(null)
              setPanel({ kind: 'remove', product: row })
            }}
          />
        </div>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title="商品管理"
        count={data?.total}
        actions={
          <>
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              leftIcon={<RefreshIcon className="size-3.5" />}
              disabled={operation}
              onClick={() => refresh()}
            >
              刷新
            </Button>
            <Button
              size="xsmall"
              mode="stroke"
              variant="neutral"
              leftIcon={<UploadIcon className="size-3.5" />}
              disabled={!canWrite || operation}
              onClick={() => setPanel({ kind: 'import' })}
            >
              导入资料
            </Button>
            <Tooltip content={!canImportAi ? '需要可用的 AI 生图插件和商品导入能力' : ''}>
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                leftIcon={<RegenerateIcon className="size-3.5" />}
                disabled={!canWrite || !canImportAi || operation}
                onClick={() => setPanel({ kind: 'ai' })}
              >
                从 AI 生图导入
              </Button>
            </Tooltip>
            <Button
              size="xsmall"
              leftIcon={<AddIcon className="size-3.5" />}
              disabled={!canWrite || operation}
              onClick={() => setPanel({ kind: 'edit', product: null })}
            >
              新建商品
            </Button>
          </>
        }
      />
      <PluginWorkspace>
        <ProductFilters query={query} onChange={setQuery} />
        {readOnly && (
          <Alert status="warning" variant="lighter">
            商品存储不可持久化，当前只读。
          </Alert>
        )}
        {error && panel?.kind !== 'remove' && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 text-secondary text-text-sub-600">
            <span>已选 {selected.size} 件 · 保留跨页选择</span>
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              onClick={() => setSelected(new Set())}
            >
              清空选择
            </Button>
          </div>
        )}
        <ListColumn>
          <DataList
            aria-label="商品列表"
            items={rows}
            columns={columns}
            rowHeight={56}
            getId={(row) => row.id}
            getName={(row) => row.name}
            labels={{
              selectAll: '全选当前页商品',
              select: (name) => `选择 ${name}`,
              more: '商品操作',
              actions: '商品操作',
            }}
            status={!current ? 'loading' : current.error ? 'error' : 'ready'}
            error={
              current?.error ? (
                <EmptyState
                  title="无法读取商品"
                  hint={current.error}
                  action={{ label: '重试', onClick: () => refresh() }}
                />
              ) : undefined
            }
            empty={
              <EmptyState
                title={
                  query.query ||
                  query.status ||
                  query.publicationStatus ||
                  query.sourceKind
                    ? '没有匹配的商品'
                    : '暂无商品'
                }
              />
            }
            selected={selected}
            onSelectedChange={(ids) =>
              setSelected((previous) => {
                const next = new Set(previous)
                for (const row of rows) {
                  if (ids.has(row.id)) next.add(row.id)
                  else next.delete(row.id)
                }
                return next
              })
            }
          />
        </ListColumn>
        <Pager
          page={data?.page ?? query.page}
          pageSize={data?.pageSize ?? query.pageSize}
          total={data?.total}
          busy={operation || !current}
          onChange={(page, pageSize) => setQuery({ ...query, page, pageSize })}
        />
      </PluginWorkspace>
      {panel?.kind === 'edit' && (
        <ProductEditor
          product={panel.product}
          canWrite={canWrite}
          onClose={() => setPanel(null)}
          onSaved={() => {
            setPanel(null)
            toast.saved('商品已保存')
            refresh(panel.product === null)
          }}
        />
      )}
      {panel?.kind === 'remove' && (
        <AlertModal
          open
          status="error"
          title="删除商品"
          description={`删除「${panel.product.name}」及其商品库发布记录？不会撤下平台上的刊登。${error ? `\n${error}` : ''}`}
          confirmLabel="删除商品"
          isLoading={operation}
          onOpenChange={(open) => {
            if (!open && !active.current) {
              setError(null)
              setPanel(null)
            }
          }}
          onConfirm={() => remove(panel.product)}
        />
      )}
      {panel?.kind === 'history' && (
        <PublicationHistory product={panel.product} onClose={() => setPanel(null)} />
      )}
      {panel?.kind === 'import' && (
        <ImportDialog onClose={() => setPanel(null)} onImported={() => refresh(true)} />
      )}
      {panel?.kind === 'ai' && (
        <AiImportDialog onClose={() => setPanel(null)} onImported={() => refresh(true)} />
      )}
    </>
  )
}
