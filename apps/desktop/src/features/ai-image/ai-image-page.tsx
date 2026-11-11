import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ImageIcon, Loader2, RefreshCw, Settings2, Sparkles, Wand2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { FieldError } from '@/components/ui/field'
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
import { pluginHostAvailable, type PluginView } from '@/lib/platform/native-plugins'
import { PluginGate } from '@/features/plugins/plugin-gate'
import { watchPluginCatalog } from '@/features/plugins/watch-plugin-catalog'
import { listPresets, listProviders, listRecords } from './api'
import { RecordDetailDialog } from './detail-dialog'
import { GenerateDialog } from './generate-dialog'
import { handoffImages } from './reference-transfer'
import { SourceLink } from './source-link'
import { ProvidersSheet } from './providers-sheet'
import { RecordImage } from './record-image'
import { BatchSummary } from './batch-summary'
import { EMPTY_SELECTIONS } from './model-selection'
import { hasImageWork } from './history-polling'
import type { AiImageHandoff } from '@/lib/page-handoff'
import {
  AI_IMAGE_PLUGIN_ID,
  formatTime,
  message,
  recordTitle,
  statusText,
  RECORD_KINDS,
  type GenerationSummary,
  type ProviderCatalog,
  type RecordStatus,
  type RecordKind,
  type RecordHistoryFilters,
  type ScenePreset,
} from './types'

const PAGE_SIZE = 10

const FILTERS: { value: RecordStatus | 'queued' | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '生成中' },
  { value: 'success', label: '已生成' },
  { value: 'failed', label: '失败' },
]

export interface AiImagePageProps {
  plugin: PluginView | null
  hostAvailable: boolean
  presentation?: 'page' | 'dialog'
  /** Pictures another page sent over; `null` means nothing is pending. */
  handoff?: AiImageHandoff | null
  onHandoffConsumed?: () => void
}

export function AiImagePage({
  plugin,
  hostAvailable,
  presentation = 'page',
  handoff = null,
  onHandoffConsumed,
}: AiImagePageProps) {
  const showHistory = presentation === 'page'
  const running = hostAvailable && plugin?.enabled === true && plugin.state === 'running'
  const pluginId = plugin?.id
  const pluginVersion = plugin?.version
  const pluginPid = plugin?.status?.pid
  const pluginMethodsKey = JSON.stringify(plugin?.methods ?? [])
  const providerLifecycle = useMemo(
    () => ({ running, pluginId, pluginVersion, pluginPid, pluginMethodsKey }),
    [running, pluginId, pluginVersion, pluginPid, pluginMethodsKey],
  )
  const providerRequest = useRef<{
    lifecycle: typeof providerLifecycle | null
    revision: number
  }>({ lifecycle: null, revision: 0 })
  const recordsRequest = useRef(0)
  // Rows remember the query they belong to, so switching filter or page shows the
  // skeleton during the fetch without an effect that resets state by hand.
  const [rows, setRows] = useState<{ key: string; items: GenerationSummary[] } | null>(
    null,
  )
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState<RecordStatus | 'queued' | 'all'>('all')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<RecordKind | 'all'>('all')
  const [providerState, setProviderState] = useState<{
    lifecycle: typeof providerLifecycle
    catalog: ProviderCatalog
  } | null>(null)
  const [presets, setPresets] = useState<ScenePreset[]>([])
  const [storageDurable, setStorageDurable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [configuring, setConfiguring] = useState(false)

  const queryKey = JSON.stringify([filter, query, kind, page])
  const historyFilters = useMemo<RecordHistoryFilters>(
    () => ({
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(kind === 'all' ? {} : { kind }),
      ...(filter === 'queued'
        ? { activity: 'queued' }
        : filter === 'running'
          ? { activity: 'active' }
          : {}),
    }),
    [query, kind, filter],
  )
  const statusFilter =
    filter === 'all' ? undefined : filter === 'queued' ? 'running' : filter
  const records = rows !== null && rows.key === queryKey ? rows.items : null
  const catalog =
    providerState?.lifecycle === providerLifecycle ? providerState.catalog : null
  const providers = catalog?.items ?? []
  const selections = catalog?.selections ?? EMPTY_SELECTIONS
  const modelConfigReady = running && catalog?.modelConfigVersion === 2

  // Invalidate requests at commit, including a replacement process seen as running.
  useLayoutEffect(() => {
    const request = providerRequest.current
    request.lifecycle = providerLifecycle
    return () => {
      request.lifecycle = null
      request.revision += 1
    }
  }, [providerLifecycle])

  const refreshRecords = useCallback(async () => {
    if (
      !showHistory ||
      !providerLifecycle.running ||
      providerRequest.current.lifecycle !== providerLifecycle
    )
      return
    const revision = ++recordsRequest.current
    const isCurrent = () =>
      providerRequest.current.lifecycle === providerLifecycle &&
      recordsRequest.current === revision
    const key = queryKey
    try {
      const result = await listRecords(
        page,
        PAGE_SIZE,
        statusFilter,
        undefined,
        historyFilters,
      )
      if (!isCurrent()) return
      const lastPage = Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1)
      if (page > lastPage) {
        setPage(lastPage)
        return
      }
      setRows({ key, items: result.items })
      setTotal(result.total)
      setStorageDurable(result.storageDurable)
      setError(null)
    } catch (cause) {
      if (!isCurrent()) return
      setRows({ key, items: [] })
      setTotal(0)
      setError(message(cause))
    }
  }, [page, queryKey, statusFilter, historyFilters, providerLifecycle, showHistory])

  const refreshProviders = useCallback(async () => {
    const request = providerRequest.current
    if (!providerLifecycle.running || request.lifecycle !== providerLifecycle) return
    const revision = ++request.revision
    const isCurrent = () =>
      request.lifecycle === providerLifecycle && request.revision === revision
    try {
      await listProviders().then((result) => {
        if (!isCurrent()) return
        setProviderState({ lifecycle: providerLifecycle, catalog: result })
        setStorageDurable(result.storageDurable)
        if (!showHistory) setError(null)
      })
    } catch (cause) {
      if (isCurrent()) setError(message(cause))
      throw cause
    }
  }, [providerLifecycle, showHistory])

  // Keep state writes in promise callbacks and share ordering with explicit refreshes.
  useEffect(() => {
    if (!running || !showHistory) return
    const revision = ++recordsRequest.current
    const key = queryKey
    let active = true
    const isCurrent = () =>
      active &&
      providerRequest.current.lifecycle === providerLifecycle &&
      recordsRequest.current === revision
    void listRecords(page, PAGE_SIZE, statusFilter, undefined, historyFilters).then(
      (result) => {
        if (!isCurrent()) return
        const lastPage = Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1)
        if (page > lastPage) {
          setPage(lastPage)
          return
        }
        setRows({ key, items: result.items })
        setTotal(result.total)
        setStorageDurable(result.storageDurable)
        setError(null)
      },
      (cause: unknown) => {
        if (!isCurrent()) return
        setRows({ key, items: [] })
        setTotal(0)
        setError(message(cause))
      },
    )
    return () => {
      active = false
      recordsRequest.current += 1
    }
  }, [
    running,
    page,
    queryKey,
    statusFilter,
    historyFilters,
    providerLifecycle,
    showHistory,
  ])

  useEffect(() => {
    if (!running) return
    let active = true
    void refreshProviders().catch(() => undefined)
    void listPresets().then(
      (result) => {
        if (active) setPresets(result.presets)
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [running, refreshProviders])

  const refreshGeneration = useCallback(async () => {
    if (
      !providerLifecycle.running ||
      providerRequest.current.lifecycle !== providerLifecycle
    )
      return
    // The task already exists; a preference read failure must not invite resubmission.
    await Promise.all([refreshRecords(), refreshProviders().catch(() => undefined)])
  }, [providerLifecycle, refreshRecords, refreshProviders])

  const hasRunning = useMemo(
    () =>
      (records ?? []).some(
        (record) =>
          record.status === 'running' || record.outputVision?.status === 'running',
      ),
    [records],
  )

  const shouldPollHistory =
    showHistory && running && (hasRunning || hasImageWork(plugin?.status))

  // Active work can be outside the current filter or page.
  useEffect(() => {
    if (!shouldPollHistory) return
    const timer = setInterval(() => {
      void refreshRecords()
    }, 2500)
    return () => clearInterval(timer)
  }, [shouldPollHistory, refreshRecords])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const showHeader = hostAvailable && plugin !== null && running

  /**
   * A handoff from another page opens the dialog by itself, but only once the
   * plugin is running: until then there is nothing to upload the pictures to.
   * Deriving it from props keeps the effect out of the picture entirely.
   */
  const pendingHandoff = handoff !== null && running
  const initialImages = useMemo(() => handoffImages(handoff), [handoff])

  const dialogs = (
    <>
      {running && (generating || pendingHandoff) ? (
        <GenerateDialog
          key={handoff === null ? 'manual' : JSON.stringify(handoff)}
          providers={providers}
          selections={selections}
          modelConfigReady={modelConfigReady}
          presets={presets}
          pluginMethods={plugin?.methods}
          initialImages={initialImages}
          loadError={showHistory ? null : error}
          {...(showHistory
            ? {}
            : {
                submittedMessage: '已提交生成任务，可在商品的生图历史中查看进度',
              })}
          {...(handoff?.source === undefined ? {} : { source: handoff.source })}
          {...(handoff?.initialPrompt === undefined
            ? {}
            : { initialPrompt: handoff.initialPrompt })}
          onOpenChange={(open) => {
            setGenerating(open)
            // Closing the dialog ends the handoff, otherwise it would reopen.
            if (!open) onHandoffConsumed?.()
          }}
          onSubmitted={refreshGeneration}
          onModelsChanged={refreshProviders}
          onConfigure={() => setConfiguring(true)}
        />
      ) : null}

      {configuring ? (
        <ProvidersSheet
          key={JSON.stringify(providerLifecycle)}
          providers={providers}
          modelConfigReady={modelConfigReady}
          pluginMethods={plugin?.methods}
          storageDurable={storageDurable}
          onOpenChange={setConfiguring}
          onChanged={refreshProviders}
          onTestSubmitted={refreshGeneration}
        />
      ) : null}

      {detailId === null ? null : (
        <RecordDetailDialog
          key={detailId}
          recordId={detailId}
          providers={providers}
          selections={selections}
          modelConfigReady={modelConfigReady}
          onClose={() => setDetailId(null)}
          onChanged={refreshGeneration}
        />
      )}
    </>
  )
  if (!showHistory) return dialogs

  return (
    <section
      className="collection-page page-reveal ai-viewport"
      aria-labelledby="ai-heading"
    >
      <Card className="ai-shell">
        <div className="ai-shell-head">
          <div>
            <h1 className="page-heading" id="ai-heading">
              AI 生图
            </h1>
            <p className="page-description">
              每次提交集中为一个批次，多视角与成片保存在同一详情中。最多同时执行两个生成任务，其余排队。
            </p>
          </div>
          <div className="section-actions">
            <Button
              variant="outline"
              size="sm"
              disabled={!showHeader}
              onClick={() => setConfiguring(true)}
            >
              <Settings2 data-icon="inline-start" />
              模型配置
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!showHeader}
              onClick={() => {
                void refreshRecords()
                void refreshProviders().catch(() => undefined)
              }}
            >
              <RefreshCw data-icon="inline-start" />
              刷新
            </Button>
            <Button
              size="sm"
              disabled={!showHeader || providers.length === 0}
              onClick={() => setGenerating(true)}
            >
              <Sparkles data-icon="inline-start" />
              新建生成
            </Button>
          </div>
        </div>

        {showHeader ? (
          <div className="ai-toolbar flex-wrap gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="search"
                aria-label="搜索生成批次"
                placeholder="搜索批次、商品、提示词或模型"
                maxLength={200}
                className="w-64 max-w-full"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setPage(0)
                }}
              />
              <LabeledSelect
                ariaLabel="任务类型"
                className="w-36"
                value={kind}
                options={RECORD_KINDS}
                onValueChange={(value) => {
                  if (!RECORD_KINDS.some((entry) => entry.value === value)) return
                  setKind(value as RecordKind | 'all')
                  setPage(0)
                }}
              />
            </div>
            <div className="ai-filters" role="tablist" aria-label="按状态筛选">
              {FILTERS.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  role="tab"
                  aria-selected={filter === entry.value}
                  className={filter === entry.value ? 'ai-filter is-active' : 'ai-filter'}
                  onClick={() => {
                    setFilter(entry.value)
                    setPage(0)
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <span className="ai-muted">
              {storageDurable ? '' : '仅本次运行 · '}共 {total} 个批次 / 任务
            </span>
          </div>
        ) : null}

        <div className="ai-body">
          {showHeader ? (
            <>
              {error === null ? null : <FieldError role="alert">{error}</FieldError>}
              {records === null ? (
                <div className="ai-skeleton-list">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : records.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>
                      {filter === 'all' && !query.trim() && kind === 'all'
                        ? '还没有生成记录'
                        : '没有符合条件的批次或任务'}
                    </EmptyTitle>
                    <EmptyDescription>
                      {providers.length === 0
                        ? '先在模型配置里保存一个服务商，然后就可以生成图片。'
                        : '点右上角「新建生成」，上传参考图或直接写提示词。'}
                    </EmptyDescription>
                  </EmptyHeader>
                  {providers.length === 0 ? (
                    <Button variant="outline" onClick={() => setConfiguring(true)}>
                      <Settings2 data-icon="inline-start" />
                      配置模型
                    </Button>
                  ) : (
                    <Button onClick={() => setGenerating(true)}>
                      <Wand2 data-icon="inline-start" />
                      新建生成
                    </Button>
                  )}
                </Empty>
              ) : (
                <div className="ai-table-scroll">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="ai-col-thumb">预览</TableHead>
                        <TableHead>内容</TableHead>
                        <TableHead className="ai-col-status">状态</TableHead>
                        <TableHead className="ai-col-model">模型</TableHead>
                        <TableHead className="ai-col-time">时间</TableHead>
                        <TableHead className="ai-col-actions" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {records.map((record) => (
                        <TableRow
                          key={record.id}
                          className="ai-row"
                          tabIndex={0}
                          onClick={() => setDetailId(record.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              setDetailId(record.id)
                            }
                          }}
                        >
                          <TableCell>
                            <span className="ai-row-thumb">
                              {record.outputs[0] === undefined ? (
                                <ImageIcon aria-hidden="true" />
                              ) : (
                                <RecordImage
                                  file={record.outputs[0]}
                                  alt={recordTitle(record)}
                                />
                              )}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="ai-row-title">{recordTitle(record)}</div>
                            <BatchSummary record={record} />
                            <div className="ai-row-prompt">{record.prompt}</div>
                            {record.source ? <SourceLink source={record.source} /> : null}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                record.status === 'success'
                                  ? 'secondary'
                                  : record.status === 'failed'
                                    ? 'destructive'
                                    : 'outline'
                              }
                            >
                              {record.status === 'running' ? (
                                <Loader2
                                  className="size-3 animate-spin"
                                  aria-hidden="true"
                                />
                              ) : null}
                              {statusText(record)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="ai-row-model">{record.imageModel}</div>
                            <div className="ai-row-prompt">{record.providerName}</div>
                          </TableCell>
                          <TableCell>
                            <div className="ai-row-model">
                              {formatTime(record.createdAt)}
                            </div>
                            <div className="ai-row-prompt">
                              {record.outputs.length > 0
                                ? `${String(record.outputs.length)} 张输出`
                                : record.mode === 'edit'
                                  ? '改图'
                                  : '文生图'}
                            </div>
                          </TableCell>
                          <TableCell className="ai-col-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(event) => {
                                event.stopPropagation()
                                setDetailId(record.id)
                              }}
                            >
                              查看
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          ) : plugin?.state === 'available' || plugin?.enabled === false ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {plugin.state === 'available'
                    ? 'AI 生图插件尚未安装'
                    : 'AI 生图插件已禁用'}
                </EmptyTitle>
                <EmptyDescription>请到插件中心安装或启用后再试。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <PluginGate label="AI 生图" plugin={plugin} hostAvailable={hostAvailable} />
          )}
        </div>

        {showHeader && records !== null && records.length > 0 ? (
          <div className="ai-shell-foot">
            <span className="ai-muted">
              第 {page + 1} / {pages} 页
            </span>
            <div className="ai-pager">
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page + 1 >= pages}
                onClick={() => setPage((current) => current + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      {dialogs}
    </section>
  )
}

export function AiImageRoute({
  handoff = null,
  onHandoffConsumed,
}: {
  handoff?: AiImageHandoff | null
  onHandoffConsumed?: () => void
} = {}) {
  const hostAvailable = pluginHostAvailable()
  const [plugin, setPlugin] = useState<PluginView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(
    () =>
      watchPluginCatalog(
        (catalog) => {
          setPlugin(catalog.find((entry) => entry.id === AI_IMAGE_PLUGIN_ID) ?? null)
          setError(null)
        },
        () => {
          setPlugin(null)
          setError('无法读取 AI 生图插件状态，请检查插件中心。')
        },
      ),
    [],
  )

  return (
    <>
      {error === null ? null : <FieldError role="alert">{error}</FieldError>}
      <AiImagePage
        plugin={plugin}
        hostAvailable={hostAvailable}
        handoff={handoff}
        {...(onHandoffConsumed === undefined ? {} : { onHandoffConsumed })}
      />
    </>
  )
}
