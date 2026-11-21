import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  DataList,
  EmptyState,
  Modal,
  type DataListColumn,
} from '@proxyshard/shardx-ui-kit'
import { PageHeader } from '../../../widgets/PageHeader'
import { ListColumn } from '../../../shared/ui/ListColumn'
import { EyeIcon } from '../../../shared/icons'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import { isNativeRaccoon } from '../../../raccoon/runtime'
import {
  listPresets,
  listProviders,
  listRecords,
} from '../../../raccoon/plugins/ai-image/api'
import {
  supportsAiFeature,
  supportsAiPage,
} from '../../../raccoon/plugins/ai-image/page-contract'
import { handoffImages } from '../../../raccoon/plugins/ai-image/reference-transfer'
import { hasImageWork } from '../../../raccoon/plugins/ai-image/history-polling'
import {
  formatTime,
  message,
  recordTitle,
  statusText,
  type AiImageHandoff,
  type GenerationRecord,
  type GenerationSource,
  type GenerationSummary,
  type Provider,
  type ProviderCatalog,
  type RecordHistoryFilters,
  type RecordKind,
  type RecordPage,
  type RecordStatus,
  type ScenePreset,
} from '../../../raccoon/plugins/ai-image/types'
import { GenerateDialog } from './GenerateDialog'
import { ProvidersDialog } from './ProvidersDialog'
import { RecordDetail } from './RecordDetail'
import { RecordImage } from './RecordImage'
import { Failure } from './fields'
import { HistoryFilters } from './HistoryFilters'
import { PluginRowAction } from '../PluginRowAction'
import { PluginCard, PluginWorkspace } from '../PluginWorkspace'

const PAGE_SIZE = 20
const PRODUCT_IMPORT_METHODS = [
  'products.sources.find',
  'products.importAi',
  'products.upload.begin',
  'products.upload.chunk',
  'products.upload.finish',
  'products.upload.abort',
  'products.images.discard',
]

interface AiImagePageProps {
  onManage: () => void
  source?: GenerationSource
  handoff?: AiImageHandoff | null
  embedded?: boolean
  onHandoffConsumed?: (record?: GenerationRecord) => void
  loadVintedImage?: (itemId: string, url: string, signal: AbortSignal) => Promise<Blob>
}

export function AiImagePage(props: AiImagePageProps) {
  const plugin = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === 'studio.ai-image'),
  )
  const handoffKey = useMemo(() => crypto.randomUUID(), [props.handoff])
  const lifecycle = JSON.stringify([
    plugin?.version,
    plugin?.enabled,
    plugin?.state,
    plugin?.installation,
    plugin?.runtimeGeneration,
    plugin?.methods,
    plugin?.granted,
    props.source?.pluginId,
    props.source?.itemId,
    handoffKey,
  ])
  return <AiImageContent key={lifecycle} {...props} />
}

function AiImageContent({
  onManage,
  source,
  handoff = null,
  embedded = false,
  onHandoffConsumed,
  loadVintedImage,
}: AiImagePageProps) {
  const plugin = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === 'studio.ai-image'),
  )
  const product = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === 'studio.products'),
  )
  const ready = isNativeRaccoon() && supportsAiPage(plugin)
  const hostBusy = hasImageWork(
    plugin?.status && typeof plugin.status === 'object' && !Array.isArray(plugin.status)
      ? (plugin.status as Record<string, unknown>)
      : null,
  )
  const canImport =
    !!product &&
    product.enabled &&
    product.state === 'running' &&
    product.storageDurable &&
    product.capabilities.includes('product.catalog') &&
    product.granted.includes('product.catalog') &&
    PRODUCT_IMPORT_METHODS.every((method) => product.methods.includes(method))
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null)
  const [presets, setPresets] = useState<ScenePreset[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<RecordKind | 'all'>('all')
  const [filter, setFilter] = useState('all')
  const [page, setPage] = useState(0)
  const [epoch, setEpoch] = useState(0)
  const [history, setHistory] = useState<{
    key: string
    result?: RecordPage
    error?: string
  } | null>(null)
  const [generating, setGenerating] = useState(!!handoff)
  const [configuring, setConfiguring] = useState(false)
  const [testing, setTesting] = useState<Provider | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [visible, setVisible] = useState(() => !document.hidden)
  const active = useRef(false)
  const catalogRequest = useRef(0)
  const sourceKey = source ? `${source.pluginId}:${source.itemId}` : ''
  const key = JSON.stringify([query, kind, filter, page, sourceKey, epoch])
  const rows = history?.key === key ? history : null
  const initialImages = handoffImages(handoff)

  useEffect(() => {
    active.current = true
    const visibility = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      active.current = false
      catalogRequest.current++
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])
  const reloadModels = useCallback(async () => {
    const revision = ++catalogRequest.current
    try {
      const [next, scenes] = await Promise.all([listProviders(), listPresets()])
      if (!active.current || revision !== catalogRequest.current) return
      setCatalog(next)
      setPresets(scenes.presets)
      setLoadError(null)
    } catch (cause) {
      if (active.current && revision === catalogRequest.current)
        setLoadError(message(cause))
      throw cause
    }
  }, [])
  useEffect(() => {
    if (ready) void reloadModels().catch(() => undefined)
  }, [ready, reloadModels])
  useEffect(() => {
    if (!ready || !visible) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const filters: RecordHistoryFilters = {
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(kind !== 'all' ? { kind } : {}),
      ...(filter === 'queued'
        ? { activity: 'queued' }
        : filter === 'running'
          ? { activity: 'active' }
          : {}),
    }
    const status: RecordStatus | undefined =
      filter === 'all'
        ? undefined
        : filter === 'queued'
          ? 'running'
          : (filter as RecordStatus)
    async function load() {
      try {
        const [result, activity] = await Promise.all([
          listRecords(page, PAGE_SIZE, status, source, filters),
          listRecords(0, 1, 'running', source),
        ])
        if (cancelled) return
        const last = Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1)
        if (page > last) {
          setPage(last)
          return
        }
        setHistory({ key, result })
        if (
          activity.total > 0 ||
          hostBusy ||
          result.items.some((record) => record.outputVision?.status === 'running')
        )
          timer = setTimeout(() => void load(), 2500)
      } catch (cause) {
        if (!cancelled) setHistory({ key, error: message(cause) })
      }
    }
    timer = setTimeout(() => void load(), query ? 250 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ready, visible, key, page, query, kind, filter, source, hostBusy])
  async function changed() {
    setEpoch((current) => current + 1)
    await reloadModels()
  }
  function submitted(record: GenerationRecord) {
    setGenerating(false)
    setTesting(null)
    setDetail(record.id)
    onHandoffConsumed?.(record)
    setEpoch((current) => current + 1)
  }
  const columns: DataListColumn<GenerationSummary>[] = [
    {
      id: 'preview',
      header: '成片',
      width: '72px',
      cell: (record) =>
        record.outputs[0] ? (
          <RecordImage
            file={record.outputs[0]}
            alt={recordTitle(record)}
            className="h-10 w-12"
          />
        ) : (
          <span className="text-secondary text-text-soft-400">—</span>
        ),
    },
    {
      id: 'title',
      header: '批次 / 商品',
      width: 'minmax(200px, 1fr)',
      cell: (record) => (
        <div className="min-w-0">
          <div className="truncate text-body text-text-strong-950">
            {recordTitle(record)}
          </div>
          <div className="truncate text-help text-text-sub-600">
            {record.source?.title ?? record.id}
          </div>
        </div>
      ),
    },
    { id: 'status', header: '状态', width: '168px', cell: statusText },
    {
      id: 'count',
      header: '成片',
      width: '72px',
      cell: (record) => (
        <span className="tabular-nums">
          {record.outputs.length}/{record.count}
        </span>
      ),
    },
    {
      id: 'model',
      header: '生图模型',
      width: '180px',
      cell: (record) => (
        <span className="truncate">
          {record.providerName} · {record.imageModel}
        </span>
      ),
    },
    {
      id: 'time',
      header: '提交时间',
      width: '172px',
      cell: (record) => (
        <span className="text-secondary tabular-nums">
          {formatTime(record.createdAt)}
        </span>
      ),
    },
  ]
  const content = !ready ? (
    <EmptyState
      title={isNativeRaccoon() ? 'AI 生图插件尚不可用' : '请在桌面应用中使用 AI 生图'}
      hint={plugin?.lastError ?? '请安装、启用并授权运行当前版本的 AI 生图插件'}
      action={{ label: '管理插件', onClick: onManage }}
    />
  ) : (
    <>
      <HistoryFilters
        query={query}
        status={filter}
        kind={kind}
        pageShortcut={!embedded}
        onQuery={(value) => {
          setQuery(value)
          setPage(0)
        }}
        onStatus={(value) => {
          setFilter(value)
          setPage(0)
        }}
        onKind={(value) => {
          setKind(value)
          setPage(0)
        }}
        onRefresh={() => {
          setEpoch((current) => current + 1)
          void reloadModels().catch(() => undefined)
        }}
      />
      <Failure error={loadError} />
      {catalog && !catalog.storageDurable && (
        <Alert status="warning" variant="lighter">
          插件存储仅本次运行有效，重启不会保留任务和配置
        </Alert>
      )}
      {catalog && catalog.modelConfigVersion !== 2 && (
        <Alert status="warning" variant="lighter">
          模型配置版本不支持新任务，请更新插件；已有历史仍可查看
        </Alert>
      )}
      <ListColumn>
        <DataList<GenerationSummary>
          aria-label="AI 生图批次历史"
          items={rows?.result?.items ?? []}
          getId={(record) => record.id}
          getName={recordTitle}
          columns={columns}
          labels={{
            selectAll: '选择全部批次',
            select: (name) => `选择 ${name}`,
            more: '批次操作',
            actions: '操作',
          }}
          status={!rows ? 'loading' : rows.error ? 'error' : 'ready'}
          error={<Failure error={rows?.error ?? null} />}
          empty={
            <EmptyState title="没有匹配的生成记录" hint="调整筛选，或创建新的生图任务" />
          }
          onOpen={(record) => setDetail(record.id)}
          openOnClick
          rowActions={(record) => (
            <PluginRowAction
              label="查看详情"
              icon={<EyeIcon className="size-3.5" />}
              onClick={() => setDetail(record.id)}
            />
          )}
        />
      </ListColumn>
      <div className="flex shrink-0 items-center justify-between gap-3 text-secondary text-text-sub-600">
        <span>
          {rows?.result?.total ?? 0} 个批次 · 第 {page + 1} 页
        </span>
        <div className="flex gap-2">
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            disabled={page === 0}
            onClick={() => setPage((current) => current - 1)}
          >
            上一页
          </Button>
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            disabled={!rows?.result || (page + 1) * PAGE_SIZE >= rows.result.total}
            onClick={() => setPage((current) => current + 1)}
          >
            下一页
          </Button>
        </div>
      </div>
    </>
  )
  return (
    <>
      {!embedded && (
        <PageHeader
          title={source ? `生图历史 · ${source.title}` : 'AI 生图'}
          actions={
            <>
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={!ready || !catalog}
                onClick={() => setConfiguring(true)}
              >
                模型配置
              </Button>
              <Button
                size="xsmall"
                disabled={!ready || !catalog || catalog.modelConfigVersion !== 2}
                onClick={() => setGenerating(true)}
              >
                创建任务
              </Button>
            </>
          }
        />
      )}
      {embedded ? (
        <div className="flex h-[60vh] min-h-0 flex-col">
          <PluginCard>{content}</PluginCard>
        </div>
      ) : (
        <PluginWorkspace>{content}</PluginWorkspace>
      )}
      {ready && catalog && generating && (
        <GenerateDialog
          catalog={catalog}
          presets={presets}
          methods={plugin?.methods ?? []}
          initialImages={initialImages}
          initialPrompt={handoff?.initialPrompt}
          source={handoff?.source ?? source}
          loadVintedImage={loadVintedImage}
          onClose={() => {
            setGenerating(false)
            onHandoffConsumed?.()
          }}
          onConfigure={() => setConfiguring(true)}
          onModelsChanged={reloadModels}
          onSubmitted={submitted}
        />
      )}
      {ready && catalog && configuring && (
        <ProvidersDialog
          catalog={catalog}
          canTestImage={supportsAiFeature(plugin, 'testImage')}
          onClose={() => setConfiguring(false)}
          onChanged={reloadModels}
          onImageTest={setTesting}
        />
      )}
      {ready && catalog && testing && (
        <GenerateDialog
          catalog={catalog}
          presets={[]}
          methods={plugin?.methods ?? []}
          testProvider={testing}
          onClose={() => setTesting(null)}
          onConfigure={() => setTesting(null)}
          onModelsChanged={reloadModels}
          onSubmitted={submitted}
        />
      )}
      {ready && detail && (
        <RecordDetail
          key={detail}
          id={detail}
          catalog={catalog}
          canExport={supportsAiFeature(plugin, 'export')}
          canImport={canImport}
          onClose={() => setDetail(null)}
          onChanged={changed}
        />
      )}
    </>
  )
}

export function SourceImageHistoryDialog({
  source,
  onClose,
  onManage,
}: {
  source: GenerationSource
  onClose: () => void
  onManage: () => void
}) {
  return (
    <Modal open size="lg" title={`生图历史 · ${source.title}`} onClose={onClose}>
      <AiImagePage source={source} embedded onManage={onManage} />
    </Modal>
  )
}
