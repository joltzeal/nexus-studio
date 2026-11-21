import { useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw } from './icons'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  LabeledSelect,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './controls'

import { listAgentBatches } from './api'
import { BatchDetail } from './batch-detail'
import { PeekIcon } from '../../../shared/icons'
import { batchLabel, PRESET_LABELS, type EventStream } from './state'
import { useAgentQuery } from './use-query'
export { AgentEvents } from './agent-events'
export { BatchDetail } from './batch-detail'

export function BatchRuns({
  selectedId,
  onSelect,
  revision,
  eventCache,
}: {
  selectedId: string | null
  onSelect: (id: string | null) => void
  revision: number
  eventCache: Map<string, EventStream>
}) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [attempt, setAttempt] = useState(0)
  const list = useAgentQuery(
    JSON.stringify([page, pageSize, attempt, revision]),
    () => listAgentBatches(page, pageSize),
    3000,
  )
  const data = list.data
  const currentPage = data?.page ?? page
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize))
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto text-help [&>*]:shrink-0">
        <span>共 {data?.total ?? '…'} 个批次</span>
        <Button
          variant="outline"
          disabled={list.loading}
          onClick={() => setAttempt((value) => value + 1)}
        >
          <RefreshCw data-icon="inline-start" />
          刷新记录
        </Button>
      </div>
      {list.error ? (
        <Alert variant="destructive">
          <AlertDescription>{list.error}</AlertDescription>
        </Alert>
      ) : null}
      {list.loading ? <Skeleton className="h-24 w-full" /> : null}
      {data ? (
        <div className="min-w-0 overflow-x-auto">
          <Table aria-label="Ecom Agent 批次">
            <TableHeader>
              <TableRow>
                <TableHead>任务预设 / 创建时间</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>完成Profile</TableHead>
                <TableHead>需要处理</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((batch) => (
                <TableRow
                  key={batch.id}
                  data-state={selectedId === batch.id ? 'selected' : undefined}
                >
                  <TableCell>
                    <strong>{PRESET_LABELS[batch.preset]}</strong>
                    <p className="text-text-sub-600">
                      {new Date(batch.createdAt).toLocaleString()}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        batch.attention || batch.state === 'needs_attention'
                          ? 'destructive'
                          : 'outline'
                      }
                    >
                      {batchLabel(batch)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {batch.completed} / {batch.total}
                  </TableCell>
                  <TableCell>{batch.attention}</TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => onSelect(batch.id)}
                      aria-label={`查看批次 ${batch.id}`}
                    >
                      <PeekIcon className="size-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!data.items.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>尚无运行记录</EmptyTitle>
                <EmptyDescription>
                  创建成功的批次及其执行进度会显示在这里。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-w-0 shrink-0 items-center justify-end gap-2 overflow-x-auto border-t border-stroke-soft-200 py-2 text-help tabular-nums [&>*]:shrink-0">
        <span>
          第 {currentPage} / {pages} 页
        </span>
        <LabeledSelect
          ariaLabel="每页批次数"
          value={String(pageSize)}
          options={[20, 50].map((value) => ({
            value: String(value),
            label: `${value} / 页`,
          }))}
          onValueChange={(value) => {
            setPageSize(Number(value))
            setPage(1)
          }}
        />
        <Button
          variant="outline"
          size="icon"
          aria-label="上一页批次"
          disabled={list.loading || currentPage <= 1}
          onClick={() => setPage(currentPage - 1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="下一页批次"
          disabled={list.loading || currentPage >= pages}
          onClick={() => setPage(currentPage + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
      {selectedId ? (
        <BatchDetail
          key={selectedId}
          id={selectedId}
          cache={eventCache}
          onChanged={() => setAttempt((value) => value + 1)}
          onClose={() => onSelect(null)}
        />
      ) : null}
    </div>
  )
}
