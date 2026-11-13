import { useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
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
import { listAgentBatches } from './api'
import { BatchDetail } from './batch-detail'
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
    <div className="sales-agent-runs">
      <div className="sales-agent-toolbar">
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
        <div className="sales-agent-table">
          <Table aria-label="ecom agent 批次">
            <TableHeader>
              <TableRow>
                <TableHead>任务预设 / 创建时间</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>完成窗口</TableHead>
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
                    <p className="text-muted-foreground">
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
                      onClick={() => onSelect(batch.id)}
                      aria-label={`查看批次 ${batch.id}`}
                    >
                      查看
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
      <div className="sales-agent-pagination">
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
