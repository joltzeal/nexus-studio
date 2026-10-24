import { useCallback, useEffect, useMemo, useState } from 'react'
import { ImageIcon, Loader2, RefreshCw, Settings2, Sparkles, Wand2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { FieldError } from '@/components/ui/field'
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
import type { AiImageHandoff } from '@/lib/page-handoff'
import {
  AI_IMAGE_PLUGIN_ID,
  formatTime,
  message,
  recordTitle,
  statusText,
  type GenerationSummary,
  type Provider,
  type RecordStatus,
  type ScenePreset,
} from './types'

const PAGE_SIZE = 10

const FILTERS: { value: RecordStatus | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '生成中' },
  { value: 'success', label: '已生成' },
  { value: 'failed', label: '失败' },
]

export interface AiImagePageProps {
  plugin: PluginView | null
  hostAvailable: boolean
  /** Pictures another page sent over; `null` means nothing is pending. */
  handoff?: AiImageHandoff | null
  onHandoffConsumed?: () => void
}

export function AiImagePage({
  plugin,
  hostAvailable,
  handoff = null,
  onHandoffConsumed,
}: AiImagePageProps) {
  const running = hostAvailable && plugin?.enabled === true && plugin.state === 'running'
  // Rows remember the query they belong to, so switching filter or page shows the
  // skeleton during the fetch without an effect that resets state by hand.
  const [rows, setRows] = useState<{ key: string; items: GenerationSummary[] } | null>(
    null,
  )
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState<RecordStatus | 'all'>('all')
  const [providers, setProviders] = useState<Provider[]>([])
  const [presets, setPresets] = useState<ScenePreset[]>([])
  const [storageDurable, setStorageDurable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [configuring, setConfiguring] = useState(false)

  const queryKey = `${filter}:${String(page)}`
  const records = rows !== null && rows.key === queryKey ? rows.items : null

  const refreshRecords = useCallback(async () => {
    const key = `${filter}:${String(page)}`
    try {
      const result = await listRecords(
        page,
        PAGE_SIZE,
        filter === 'all' ? undefined : filter,
      )
      setRows({ key, items: result.items })
      setTotal(result.total)
      setStorageDurable(result.storageDurable)
      setError(null)
    } catch (cause) {
      setRows({ key, items: [] })
      setTotal(0)
      setError(message(cause))
    }
  }, [page, filter])

  const refreshProviders = useCallback(async () => {
    try {
      const result = await listProviders()
      setProviders(result.items)
      setStorageDurable(result.storageDurable)
    } catch (cause) {
      setError(message(cause))
    }
  }, [])

  // First load for the current query. The promise chain lives in the effect so
  // state is only written from the callbacks, never synchronously on mount.
  useEffect(() => {
    if (!running) return
    const key = `${filter}:${String(page)}`
    let active = true
    void listRecords(page, PAGE_SIZE, filter === 'all' ? undefined : filter).then(
      (result) => {
        if (!active) return
        setRows({ key, items: result.items })
        setTotal(result.total)
        setStorageDurable(result.storageDurable)
        setError(null)
      },
      (cause: unknown) => {
        if (!active) return
        setRows({ key, items: [] })
        setTotal(0)
        setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [running, page, filter])

  useEffect(() => {
    if (!running) return
    let active = true
    void listProviders().then(
      (result) => {
        if (active) setProviders(result.items)
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
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
  }, [running])

  const hasRunning = useMemo(
    () =>
      (records ?? []).some(
        (record) =>
          record.status === 'running' || record.outputVision?.status === 'running',
      ),
    [records],
  )

  // Only poll while something is actually being generated.
  useEffect(() => {
    if (!running || !hasRunning) return
    const timer = setInterval(() => {
      void refreshRecords()
    }, 2500)
    return () => clearInterval(timer)
  }, [running, hasRunning, refreshRecords])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const showHeader = hostAvailable && plugin !== null && running

  /**
   * A handoff from another page opens the dialog by itself, but only once the
   * plugin is running: until then there is nothing to upload the pictures to.
   * Deriving it from props keeps the effect out of the picture entirely.
   */
  const pendingHandoff = handoff !== null && running
  const initialImages = useMemo(() => handoffImages(handoff), [handoff])

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
              用 OpenAI
              或兼容接口生成与改图，可单独配置识图模型，选择一张参考图或成片识别商品。每次生成都会留下记录。
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
                void refreshProviders()
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
          <div className="ai-toolbar">
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
              {storageDurable ? '' : '仅本次运行 · '}共 {total} 条记录
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
                      {filter === 'all' ? '还没有生成记录' : '没有符合条件的记录'}
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

      {running && (generating || pendingHandoff) ? (
        <GenerateDialog
          key={handoff === null ? 'manual' : JSON.stringify(handoff)}
          providers={providers}
          presets={presets}
          pluginMethods={plugin?.methods}
          initialImages={initialImages}
          {...(handoff?.source === undefined ? {} : { source: handoff.source })}
          {...(handoff?.initialPrompt === undefined
            ? {}
            : { initialPrompt: handoff.initialPrompt })}
          onOpenChange={(open) => {
            setGenerating(open)
            // Closing the dialog ends the handoff, otherwise it would reopen.
            if (!open) onHandoffConsumed?.()
          }}
          onSubmitted={refreshRecords}
          onConfigure={() => setConfiguring(true)}
        />
      ) : null}

      {configuring ? (
        <ProvidersSheet
          providers={providers}
          storageDurable={storageDurable}
          onOpenChange={setConfiguring}
          onChanged={refreshProviders}
        />
      ) : null}

      {detailId === null ? null : (
        <RecordDetailDialog
          key={detailId}
          recordId={detailId}
          providers={providers}
          onClose={() => setDetailId(null)}
          onChanged={refreshRecords}
        />
      )}
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
