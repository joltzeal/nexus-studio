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
import {
  enablePlugin,
  listPlugins,
  pluginHostAvailable,
  restartPlugin,
  type PluginView,
} from '@/lib/platform/native-plugins'
import { listPresets, listProviders, listRecords } from './api'
import { RecordDetailDialog } from './detail-dialog'
import { GenerateDialog } from './generate-dialog'
import { ProvidersSheet } from './providers-sheet'
import { RecordImage } from './record-image'
import {
  AI_IMAGE_CAPABILITY,
  AI_IMAGE_PLUGIN_ID,
  formatTime,
  message,
  recordTitle,
  statusText,
  type GenerationRecord,
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
  onEnable?: () => Promise<void>
}

export function AiImagePage({ plugin, hostAvailable, onEnable }: AiImagePageProps) {
  const running = plugin !== null && plugin.state === 'running'
  // Rows remember the query they belong to, so switching filter or page shows the
  // skeleton during the fetch without an effect that resets state by hand.
  const [rows, setRows] = useState<{ key: string; items: GenerationRecord[] } | null>(
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
    () => (records ?? []).some((record) => record.status === 'running'),
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
              或兼容接口生成与改图，文案模型按成片写标题和描述。每次生成都会留下记录。
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
          {!hostAvailable ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>AI 生图需要桌面应用</EmptyTitle>
                <EmptyDescription>
                  生图与文案都由插件进程请求外部接口，网页预览没有插件宿主。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : plugin === null ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>AI 生图插件尚未安装</EmptyTitle>
                <EmptyDescription>
                  到插件中心安装并启用「AI 生图」后，这里可以配置模型并生成图片。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : !running ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {plugin.state === 'failed' ? '插件进程启动失败' : 'AI 生图插件未启用'}
                </EmptyTitle>
                <EmptyDescription>
                  {plugin.lastError ??
                    (plugin.enabled
                      ? '插件已授权，但进程没有运行；生成需要进程就绪。'
                      : `到插件中心启用并授予 ${AI_IMAGE_CAPABILITY} 能力后，这里可以生成图片。`)}
                </EmptyDescription>
              </EmptyHeader>
              {plugin.enabled && onEnable ? (
                <Button
                  onClick={() => {
                    void onEnable()
                  }}
                >
                  重新启动插件进程
                </Button>
              ) : null}
            </Empty>
          ) : (
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

      {generating ? (
        <GenerateDialog
          providers={providers}
          presets={presets}
          onOpenChange={setGenerating}
          onSubmitted={refreshRecords}
          onConfigure={() => {
            setGenerating(false)
            setConfiguring(true)
          }}
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
          onClose={() => setDetailId(null)}
          onChanged={refreshRecords}
        />
      )}
    </section>
  )
}

export function AiImageRoute() {
  const hostAvailable = pluginHostAvailable()
  const [plugin, setPlugin] = useState<PluginView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!hostAvailable) return
    const catalog = await listPlugins()
    setPlugin(catalog.find((entry) => entry.id === AI_IMAGE_PLUGIN_ID) ?? null)
  }, [hostAvailable])

  useEffect(() => {
    if (!hostAvailable) return
    let active = true
    void listPlugins().then(
      (catalog) => {
        if (active) {
          setPlugin(catalog.find((entry) => entry.id === AI_IMAGE_PLUGIN_ID) ?? null)
        }
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [hostAvailable])

  async function enable() {
    if (plugin === null) return
    setError(null)
    try {
      if (plugin.enabled) await restartPlugin(plugin.id)
      else await enablePlugin(plugin.id, plugin.capabilities)
      await refresh()
    } catch (cause) {
      setError(message(cause))
    }
  }

  return (
    <>
      {error === null ? null : <FieldError role="alert">{error}</FieldError>}
      <AiImagePage plugin={plugin} hostAvailable={hostAvailable} onEnable={enable} />
    </>
  )
}
