import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { watchPluginCatalog } from '@/features/plugins/watch-plugin-catalog'
import { pluginHostAvailable } from '@/lib/platform/native-plugins'
import { listProviders, listRecords } from './api'
import { RecordDetailDialog } from './detail-dialog'
import { RecordImage } from './record-image'
import { sourceHistoryAvailability } from './source-history'
import { SourceLink } from './source-link'
import { EMPTY_SELECTIONS } from './model-selection'
import {
  formatTime,
  message,
  recordTitle,
  statusText,
  type GenerationSource,
  type Provider,
  type ModelSelections,
  type RecordPage,
} from './types'

const PAGE_SIZE = 10
const GATE_TEXT = {
  desktop: ['AI 生图需要桌面应用', '插件宿主只在桌面应用中运行。'],
  missing: ['AI 生图插件尚未安装', '请到插件中心安装 AI 生图插件后重试。'],
  disabled: ['AI 生图插件已禁用', '请到插件中心启用 AI 生图插件后重试。'],
  starting: ['AI 生图插件正在启动', '正在等待实际插件进程运行，启动失败请检查插件中心。'],
} as const

export interface SourceImageHistoryDialogProps {
  source: GenerationSource
  onClose: () => void
}

/** A source change remounts queries, pagination and detail selection together. */
export function SourceImageHistoryDialog(props: SourceImageHistoryDialogProps) {
  return (
    <SourceImageHistory
      key={JSON.stringify([props.source.pluginId, props.source.itemId])}
      {...props}
    />
  )
}

function SourceImageHistory({ source, onClose }: SourceImageHistoryDialogProps) {
  const hostAvailable = pluginHostAvailable()
  const [availability, setAvailability] = useState<
    ReturnType<typeof sourceHistoryAvailability> | 'loading' | 'error'
  >(hostAvailable ? 'loading' : 'desktop')
  const [revision, setRevision] = useState(0)
  const [page, setPage] = useState(0)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [result, setResult] = useState<{
    key: string
    page: RecordPage | null
    providers: Provider[]
    selections: ModelSelections
    modelConfigReady: boolean
    error: string | null
  } | null>(null)
  const key = `${page}:${revision}`
  const current = result?.key === key ? result : null
  const ready = availability === 'ready'
  const { pluginId, itemId } = source

  useEffect(
    () =>
      watchPluginCatalog(
        (catalog) => setAvailability(sourceHistoryAvailability(hostAvailable, catalog)),
        () => setAvailability('error'),
      ),
    [hostAvailable, revision],
  )

  useEffect(() => {
    if (!ready) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function read() {
      try {
        const [records, providers] = await Promise.all([
          listRecords(page, PAGE_SIZE, undefined, { pluginId, itemId }),
          listProviders(),
        ])
        if (!active) return
        const lastPage = Math.max(0, Math.ceil(records.total / PAGE_SIZE) - 1)
        if (page > lastPage) {
          setPage(lastPage)
          return
        }
        setResult({
          key,
          page: records,
          providers: providers.items,
          selections: providers.selections,
          modelConfigReady: providers.modelConfigVersion === 2,
          error: null,
        })
        if (
          records.items.some(
            (record) =>
              record.status === 'running' || record.outputVision?.status === 'running',
          )
        ) {
          timer = setTimeout(() => void read(), 2500)
        }
      } catch (error) {
        if (active)
          setResult({
            key,
            page: null,
            providers: [],
            selections: EMPTY_SELECTIONS,
            modelConfigReady: false,
            error: message(error),
          })
      }
    }
    void read()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [ready, page, key, pluginId, itemId])

  const refresh = useCallback(async () => {
    setRevision((value) => value + 1)
  }, [])
  const gate =
    availability === 'ready' || availability === 'loading' || availability === 'error'
      ? null
      : GATE_TEXT[availability]
  const error =
    availability === 'error'
      ? '无法读取 AI 生图插件状态，请重试。'
      : ready
        ? current?.error
        : null
  const records = current?.page
  const pages = Math.max(1, Math.ceil((records?.total ?? 0) / PAGE_SIZE))

  return (
    <>
      <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>商品生图历史</DialogTitle>
            <DialogDescription>
              仅显示关联此商品的 AI 生图记录。查看历史不会自动生成图片或发起识图。
            </DialogDescription>
          </DialogHeader>
          <SourceLink source={source} />
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>读取失败</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : gate ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{gate[0]}</EmptyTitle>
                <EmptyDescription>{gate[1]}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : availability === 'loading' || (ready && current === null) ? (
            <Skeleton className="h-40 w-full" />
          ) : records?.items.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>此商品还没有生图记录</EmptyTitle>
                <EmptyDescription>
                  在商品页选择图片并手动提交生成后，记录会显示在这里。旧版未保存来源的记录不会自动关联。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : records ? (
            <div className="max-h-[50svh] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>预览</TableHead>
                    <TableHead>记录</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>时间</TableHead>
                    <TableHead>
                      <span className="sr-only">操作</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.items.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell>
                        <span className="flex size-12 items-center justify-center overflow-hidden rounded bg-muted">
                          {record.outputs[0] ? (
                            <RecordImage
                              file={record.outputs[0]}
                              alt={recordTitle(record)}
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground">无成片</span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>
                        <p className="max-w-48 truncate">{recordTitle(record)}</p>
                        <p className="text-xs text-muted-foreground">
                          {record.imageModel}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            record.status === 'failed' ? 'destructive' : 'secondary'
                          }
                        >
                          {statusText(record)}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatTime(record.createdAt)}</TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDetailId(record.id)}
                        >
                          查看详情
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
          {ready && records ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {records.storageDurable ? '' : '仅本次运行 · '}共 {records.total} 条 · 第{' '}
                {page + 1} / {pages} 页
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page === 0}
                  onClick={() => setPage((value) => value - 1)}
                >
                  上一页
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page + 1 >= pages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => void refresh()}>
              <RefreshCw data-icon="inline-start" />
              {error ? '重试' : '刷新'}
            </Button>
            <Button onClick={onClose}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {detailId !== null && ready ? (
        <RecordDetailDialog
          key={detailId}
          recordId={detailId}
          providers={result?.providers ?? []}
          selections={result?.selections ?? EMPTY_SELECTIONS}
          modelConfigReady={result?.modelConfigReady ?? false}
          onClose={() => {
            setDetailId(null)
            void refresh()
          }}
          onChanged={refresh}
        />
      ) : null}
    </>
  )
}
