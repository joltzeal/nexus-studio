import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { listRecords } from '@/features/ai-image/api'
import type { GenerationSummary, RecordPage } from '@/features/ai-image/types'
import { importGenerationProduct, type AiProductImportProgress } from './ai-import'
import { productError, productTime } from './product-form'

const PAGE_SIZE = 10
type ImportState = {
  name: string
  phase:
    | AiProductImportProgress['stage']
    | 'queued'
    | 'done'
    | 'existing'
    | 'error'
    | 'cancelled'
  completed: number
  total: number
  error?: string
}

function recordName(record: GenerationSummary) {
  return record.title || record.source?.title || record.presetLabel || record.id
}

function stateText(result: ImportState) {
  switch (result.phase) {
    case 'queued':
      return '等待导入'
    case 'checking':
      return '正在核对来源'
    case 'copying':
      return `正在复制图片 ${String(result.completed)} / ${String(result.total)}`
    case 'saving':
      return '正在保存商品'
    case 'done':
      return '已导入'
    case 'existing':
      return '已导入过，保留现有商品'
    case 'error':
      return result.error ?? '导入失败'
    case 'cancelled':
      return '已取消，可重试'
  }
}

function selectable(record: GenerationSummary) {
  return (
    record.status !== 'running' &&
    record.outputVision?.status !== 'running' &&
    record.outputs.length > 0
  )
}

export function AiProductImportDialog({
  unavailable,
  onClose,
  onImported,
}: {
  unavailable: string | null
  onClose: () => void
  onImported: () => void
}) {
  const [page, setPage] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<Map<string, GenerationSummary>>(
    () => new Map(),
  )
  const [results, setResults] = useState<Record<string, ImportState>>({})
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [history, setHistory] = useState<{
    key: string
    data: RecordPage | null
    error: string | null
  }>({ key: '', data: null, error: null })
  const active = useRef(true)
  const pending = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const key = `${String(page)}:${String(attempt)}:${unavailable ?? ''}`

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      controller.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (unavailable) {
      controller.current?.abort()
      return
    }
    let current = true
    void listRecords(page, PAGE_SIZE).then(
      (data) => {
        if (!current) return
        const lastPage = Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1)
        if (page > lastPage) {
          setPage(lastPage)
          return
        }
        setHistory({ key, data, error: null })
      },
      (cause: unknown) => {
        if (current) setHistory({ key, data: null, error: productError(cause) })
      },
    )
    return () => {
      current = false
    }
  }, [page, attempt, key, unavailable])

  const data = history.key === key ? history.data : null
  const error = history.key === key ? history.error : null
  const loading = !data && !error && !unavailable
  const rows = data?.items ?? []
  const eligible = rows.filter(selectable)
  const allSelected =
    eligible.length > 0 && eligible.every((record) => selected.has(record.id))
  const someSelected = eligible.some((record) => selected.has(record.id))
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE))
  const pendingSelection = [...selected.values()].filter(
    (record) => !['done', 'existing'].includes(results[record.id]?.phase ?? ''),
  )

  function select(record: GenerationSummary, value: boolean) {
    setSelected((current) => {
      const next = new Map(current)
      if (value) next.set(record.id, record)
      else next.delete(record.id)
      return next
    })
  }

  async function run() {
    if (pending.current || unavailable || !pendingSelection.length) return
    const batch = pendingSelection
    const abort = new AbortController()
    controller.current = abort
    pending.current = true
    setBusy(true)
    setStopping(false)
    setResults((current) => ({
      ...current,
      ...Object.fromEntries(
        batch.map((record) => [
          record.id,
          {
            name: recordName(record),
            phase: 'queued',
            completed: 0,
            total: record.outputs.length,
          } satisfies ImportState,
        ]),
      ),
    }))
    let changed = false
    try {
      for (const record of batch) {
        if (!active.current) break
        if (abort.signal.aborted) {
          setResults((current) => ({
            ...current,
            [record.id]: {
              name: recordName(record),
              phase: 'cancelled',
              completed: 0,
              total: record.outputs.length,
            },
          }))
          continue
        }
        try {
          const result = await importGenerationProduct(record.id, {
            signal: abort.signal,
            onProgress: (progress) => {
              if (active.current && !abort.signal.aborted)
                setResults((current) => ({
                  ...current,
                  [record.id]: {
                    name: recordName(record),
                    phase: progress.stage,
                    completed: progress.completed,
                    total: progress.total,
                  },
                }))
            },
          })
          changed = true
          if (active.current) {
            setResults((current) => ({
              ...current,
              [record.id]: {
                name: result.product.name,
                phase: result.alreadyImported ? 'existing' : 'done',
                completed: result.product.images.length,
                total: result.product.images.length,
              },
            }))
          }
        } catch (cause) {
          if (active.current)
            setResults((current) => ({
              ...current,
              [record.id]: {
                name: recordName(record),
                phase: abort.signal.aborted ? 'cancelled' : 'error',
                completed: 0,
                total: record.outputs.length,
                error: productError(cause),
              },
            }))
        }
      }
    } finally {
      pending.current = false
      controller.current = null
      if (active.current) {
        setBusy(false)
        setStopping(false)
        if (changed) onImported()
      }
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="sm:max-w-4xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>从 AI 生图导入商品</DialogTitle>
          <DialogDescription>
            每条生成记录对应一件商品，整组已完成图片和英文文案会复制到商品插件。
            同一记录重复导入会返回已有商品，保留手动修改；整个流程留在当前页面。
          </DialogDescription>
        </DialogHeader>
        {unavailable ? (
          <Alert>
            <AlertTitle>AI 导入暂不可用</AlertTitle>
            <AlertDescription>{unavailable}</AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                已选 {selected.size} 组。生成、识图尚未完成或没有成片的记录不可选。
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={loading || busy}
                onClick={() => setAttempt((value) => value + 1)}
              >
                <RefreshCw data-icon="inline-start" />
                刷新记录
              </Button>
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertTitle>生成历史读取失败</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {loading ? (
              <Skeleton className="h-40 w-full" aria-label="正在读取生成历史" />
            ) : data && rows.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>暂无生成记录</EmptyTitle>
                  <EmptyDescription>
                    完成生图后可在这里导入，手动商品工作流始终可用。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              data && (
                <div className="max-h-72 overflow-auto">
                  <Table aria-label="可导入的 AI 生成记录">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <Checkbox
                            aria-label="选择当前页可导入记录"
                            checked={
                              allSelected ? true : someSelected ? 'indeterminate' : false
                            }
                            disabled={busy || !eligible.length}
                            onCheckedChange={(value) => {
                              setSelected((current) => {
                                const next = new Map(current)
                                for (const record of eligible) {
                                  if (value === true) next.set(record.id, record)
                                  else next.delete(record.id)
                                }
                                return next
                              })
                            }}
                          />
                        </TableHead>
                        <TableHead>生成记录</TableHead>
                        <TableHead>成片</TableHead>
                        <TableHead>生成状态</TableHead>
                        <TableHead>创建时间</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((record) => (
                        <TableRow
                          key={record.id}
                          data-state={selected.has(record.id) ? 'selected' : undefined}
                        >
                          <TableCell>
                            <Checkbox
                              aria-label={`选择生成记录 ${recordName(record)}`}
                              checked={selected.has(record.id)}
                              disabled={busy || !selectable(record)}
                              onCheckedChange={(value) => select(record, value === true)}
                            />
                          </TableCell>
                          <TableCell>
                            <div className="flex max-w-96 min-w-0 flex-col gap-1">
                              <span className="truncate" title={recordName(record)}>
                                {recordName(record)}
                              </span>
                              <span className="truncate text-xs text-muted-foreground">
                                {record.id}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>{record.outputs.length} 张</TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                record.status === 'failed' ? 'destructive' : 'outline'
                              }
                            >
                              {record.status === 'running'
                                ? '生成中'
                                : record.status === 'failed'
                                  ? '部分失败 / 失败'
                                  : '已完成'}
                            </Badge>
                          </TableCell>
                          <TableCell>{productTime(record.createdAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {data
                  ? `共 ${String(data.total)} 组 · 第 ${String(page + 1)} / ${String(pages)} 页`
                  : loading
                    ? '正在读取记录数量…'
                    : '未能读取记录数量'}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || loading || page === 0}
                  onClick={() => setPage((value) => value - 1)}
                >
                  <ChevronLeft data-icon="inline-start" />
                  上一页
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || loading || !data || page + 1 >= pages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  下一页
                  <ChevronRight data-icon="inline-end" />
                </Button>
              </div>
            </div>
          </>
        )}
        {Object.keys(results).length > 0 && (
          <div
            aria-label="AI 商品导入进度"
            aria-live="polite"
            className="flex max-h-48 flex-col gap-2 overflow-auto"
          >
            {Object.entries(results).map(([id, result]) => (
              <Alert
                key={id}
                role={result.phase === 'error' ? 'alert' : 'status'}
                variant={result.phase === 'error' ? 'destructive' : 'default'}
              >
                <AlertTitle>{result.name}</AlertTitle>
                <AlertDescription>{stateText(result)}</AlertDescription>
              </Alert>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            关闭
          </Button>
          {busy ? (
            <Button
              type="button"
              variant="outline"
              disabled={stopping}
              onClick={() => {
                setStopping(true)
                controller.current?.abort()
              }}
            >
              {stopping ? '正在停止…' : '停止导入'}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={Boolean(unavailable) || !pendingSelection.length}
              onClick={() => void run()}
            >
              导入所选 {pendingSelection.length} 组
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
