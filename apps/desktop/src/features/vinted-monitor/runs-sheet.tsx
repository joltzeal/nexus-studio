import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, History, Loader2, RefreshCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { LabeledSelect } from '@/components/ui/labeled-select'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { listRuns } from './api'
import {
  formatTime,
  message,
  runStatusText,
  type Monitor,
  type Pagination,
  type RunList,
  type RunStatus,
} from './types'

const POLL_MS = 5000
const PAGE_SIZES = [10, 20, 50]

type RunLoader = (monitorId: string, pagination: Pagination) => Promise<RunList>
interface RunObserver {
  pending: () => void
  success: (result: RunList) => void
  error: (cause: unknown) => void
}

/** Keep discovering scheduled runs, including after empty or completed results. */
// eslint-disable-next-line react-refresh/only-export-components
export function watchRunHistory(
  monitorId: string,
  pagination: Pagination,
  observer: RunObserver,
  fetchRuns: RunLoader = listRuns,
): () => void {
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  async function refresh() {
    if (!active) return
    observer.pending()
    try {
      const result = await fetchRuns(monitorId, pagination)
      if (active) observer.success(result)
    } catch (cause) {
      if (active) observer.error(cause)
    } finally {
      // Schedule after settlement so a slow request never overlaps its next poll.
      if (active)
        timer = setTimeout(() => {
          void refresh()
        }, POLL_MS)
    }
  }
  void Promise.resolve().then(refresh)
  return () => {
    active = false
    if (timer !== undefined) clearTimeout(timer)
  }
}

function badgeVariant(status: RunStatus): 'secondary' | 'destructive' | 'outline' {
  if (status === 'success') return 'secondary'
  if (status === 'failed') return 'destructive'
  return 'outline'
}

export interface RunsSheetProps {
  monitor: Monitor
  onOpenChange: (open: boolean) => void
}

export function RunsSheet(props: RunsSheetProps) {
  return <RunHistory key={props.monitor.id} {...props} />
}

function RunHistory({ monitor, onOpenChange }: RunsSheetProps) {
  const [open, setOpen] = useState(true)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(20)
  const [revision, setRevision] = useState(0)
  const requestKey = `${monitor.id}:${String(page)}:${String(pageSize)}`
  const [state, setState] = useState<{
    key: string
    data: RunList | null
    pending: boolean
    error: string | null
  }>({ key: '', data: null, pending: true, error: null })

  useEffect(() => {
    if (!open) return
    return watchRunHistory(
      monitor.id,
      { page, pageSize },
      {
        pending: () =>
          setState((current) => ({
            key: requestKey,
            data: current.key === requestKey ? current.data : null,
            pending: true,
            error: current.key === requestKey ? current.error : null,
          })),
        success: (data) => {
          const lastPage = Math.max(0, Math.ceil(data.total / pageSize) - 1)
          if (page > lastPage) {
            setPage(lastPage)
            return
          }
          setState({ key: requestKey, data, pending: false, error: null })
        },
        error: (cause) =>
          setState((current) => ({
            key: requestKey,
            data: current.key === requestKey ? current.data : null,
            pending: false,
            error: message(cause),
          })),
      },
    )
  }, [monitor.id, page, pageSize, revision, requestKey, open])

  const current = state.key === requestKey
  const data = current ? state.data : null
  const error = current ? state.error : null
  const loading = !current || state.pending
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize))

  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        onOpenChange(value)
      }}
    >
      <SheetContent side="right" className="sm:max-w-6xl">
        <SheetHeader>
          <SheetTitle>采集记录 · {monitor.name}</SheetTitle>
          <SheetDescription>
            打开期间每 5 秒刷新，包含定时采集与手动采集。达到分页上限表示扫描不完整。
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="overflow-x-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground" role="status">
              {loading ? '正在刷新记录…' : error ? '刷新失败，可重试' : '每 5 秒自动刷新'}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCw
                data-icon="inline-start"
                className={loading ? 'animate-spin' : undefined}
              />
              刷新
            </Button>
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>采集记录读取失败</AlertTitle>
              <AlertDescription>
                {error}
                {data ? ' 当前保留上次读取的记录。' : ''}
              </AlertDescription>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 w-fit"
                disabled={loading}
                onClick={() => setRevision((value) => value + 1)}
              >
                重试
              </Button>
            </Alert>
          ) : null}
          {!data && loading ? (
            <div
              className="flex flex-col gap-3"
              aria-label="正在读取采集记录"
              aria-busy="true"
            >
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="h-9 w-full" />
              ))}
            </div>
          ) : data && data.items.length > 0 ? (
            <Table aria-label="采集记录" aria-busy={loading}>
              <TableHeader>
                <TableRow>
                  <TableHead>状态</TableHead>
                  <TableHead>开始时间</TableHead>
                  <TableHead>结束时间</TableHead>
                  <TableHead className="text-right">发现</TableHead>
                  <TableHead className="text-right">新增</TableHead>
                  <TableHead className="text-right">更新</TableHead>
                  <TableHead className="text-right">跳过旧快照</TableHead>
                  <TableHead className="text-right">卖家失败数</TableHead>
                  <TableHead className="text-right">失败数</TableHead>
                  <TableHead>达到分页上限</TableHead>
                  <TableHead>错误信息</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <Badge variant={badgeVariant(run.status)}>
                        {run.status === 'running' ? (
                          <Loader2
                            data-icon="inline-start"
                            className="animate-spin"
                            aria-hidden="true"
                          />
                        ) : null}
                        {runStatusText(run.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatTime(run.startedAt)}</TableCell>
                    <TableCell>{formatTime(run.finishedAt)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {run.discovered}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {run.inserted}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {run.updated}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {run.skipped}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {run.userFailed ?? 0}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {run.failed}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {run.truncated ? '是 · 扫描不完整' : '否'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="block min-w-48 max-w-80 whitespace-normal break-words text-destructive">
                        {run.error || '—'}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : data && !error ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <History />
                </EmptyMedia>
                <EmptyTitle>还没有采集记录</EmptyTitle>
                <EmptyDescription>
                  {monitor.enabled
                    ? '任务开始后记录会自动出现，也可返回监控列表手动采集。'
                    : '此监控已停用；启用后才会进行定时或手动采集。'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
        </SheetBody>
        <SheetFooter className="flex-row flex-wrap items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {data ? `共 ${String(data.total)} 条` : '记录数量待加载'}
            </span>
            <LabeledSelect
              ariaLabel="每页记录数"
              value={String(pageSize)}
              options={PAGE_SIZES.map((size) => ({
                value: String(size),
                label: `${String(size)} 条 / 页`,
              }))}
              onValueChange={(value) => {
                const size = Number(value)
                if (PAGE_SIZES.includes(size)) {
                  setPage(0)
                  setPageSize(size)
                }
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="上一页"
              disabled={page === 0}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
            >
              <ChevronLeft data-icon="inline-start" />
            </Button>
            <span className="text-xs tabular-nums">
              第 {page + 1} / {data ? pageCount : '—'} 页
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="下一页"
              disabled={!data || page + 1 >= pageCount}
              onClick={() => setPage((value) => value + 1)}
            >
              <ChevronRight data-icon="inline-start" />
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
