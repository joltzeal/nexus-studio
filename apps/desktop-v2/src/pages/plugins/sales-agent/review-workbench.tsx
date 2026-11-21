import { useState } from 'react'
import type { AgentAttentionPage } from '@nexus/plugin-sdk/agent'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './controls'

import { navigateDetail } from '../../../raccoon/plugins/detail-navigation'
import { PeekIcon, NavAutomationIcon } from '../../../shared/icons'
import { listAgentAttention, listAgentRelated } from './api'
import { AgentPagination } from './agent-pagination'
import { JobItems } from './job-items'
import { recoveryHint, stageLabel } from './presentation'
import { JOB_LABELS } from './state'
import { useAgentQuery } from './use-query'

export interface RelatedAgentHistory {
  kind: 'product' | 'account' | 'window'
  id: string
}

const RELATION_LABELS = { product: '商品', window: 'Profile', account: '账号' } as const

export function ReviewWorkbench({
  related,
  onClearRelated,
  onOpenBatch,
}: {
  related?: RelatedAgentHistory | null
  onClearRelated?: () => void
  onOpenBatch: (id: string) => void
}) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<AgentAttentionPage['items'][number] | null>(
    null,
  )
  const result = useAgentQuery(
    JSON.stringify([related?.kind, related?.id, page, pageSize, attempt]),
    () =>
      related
        ? listAgentRelated(related.kind, related.id, page, pageSize)
        : listAgentAttention(page, pageSize),
    4000,
  )
  const selectedRow =
    result.data?.items.find((row) => row.jobId === selected?.jobId) ?? selected
  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-label={related ? '关联运行历史' : '待处理工作台'}
    >
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto text-help [&>*]:shrink-0">
        <strong>{related ? '关联运行历史（含已结束任务）' : '全部批次待处理'}</strong>
        {related ? (
          <>
            <Badge variant="outline" hint={related.id}>
              {RELATION_LABELS[related.kind]}
            </Badge>
            <Button size="sm" variant="ghost" onClick={onClearRelated}>
              返回全部待处理
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={result.loading}
          onClick={() => setAttempt((value) => value + 1)}
        >
          刷新工作台
        </Button>
      </div>
      {result.error ? (
        <Alert variant="destructive">
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      ) : null}
      {result.loading ? <Skeleton className="h-24 w-full" /> : null}
      {result.data ? (
        <>
          <div className="min-w-0 overflow-x-auto">
            <Table aria-label={related ? '关联任务列表' : '全部待处理Profile'}>
              <TableHeader>
                <TableRow>
                  <TableHead>Profile / 账号</TableHead>
                  <TableHead>状态 / 阶段</TableHead>
                  <TableHead>原因与下一步</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.items.map((row) => (
                  <TableRow key={row.jobId}>
                    <TableCell>
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() =>
                          navigateDetail({ kind: 'window', id: row.windowId })
                        }
                      >
                        {row.windowName}
                      </Button>
                      <p>
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() =>
                            navigateDetail({ kind: 'account', id: row.accountId })
                          }
                        >
                          {row.account}
                        </Button>
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          ['completed', 'cancelled', 'skipped'].includes(row.state)
                            ? 'outline'
                            : 'destructive'
                        }
                      >
                        {JOB_LABELS[row.state]}
                      </Badge>
                      <p className="text-help text-text-sub-600">
                        {stageLabel(row.phase)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <p className="max-w-[440px] whitespace-pre-wrap text-help wrap-anywhere">
                        {row.message || '—'}
                      </p>
                      <p className="text-help text-text-sub-600">
                        {recoveryHint(row.state)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-2 overflow-x-auto text-help [&>*]:shrink-0">
                        <Button
                          size="icon"
                          aria-label="查看商品与审查"
                          variant="outline"
                          disabled={!!result.error}
                          onClick={() => setSelected(row)}
                        >
                          <PeekIcon className="size-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          aria-label="查看批次"
                          variant="ghost"
                          onClick={() => onOpenBatch(row.batchId)}
                        >
                          <NavAutomationIcon className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {!result.data.items.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{related ? '没有关联运行记录' : '暂无待处理任务'}</EmptyTitle>
                <EmptyDescription>
                  {related
                    ? `此${RELATION_LABELS[related.kind]}尚无关联运行记录。这里展示全部状态的任务，包括进行中、已完成和已取消的记录。`
                    : '结果不明、记录待同步及需要人工检查的Profile会集中显示在这里。'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          <AgentPagination
            label="记录"
            total={result.data.total}
            page={result.data.page}
            pageSize={pageSize}
            busy={result.loading}
            onPage={setPage}
            onPageSize={(size) => {
              setPageSize(size)
              setPage(1)
            }}
          />
        </>
      ) : null}
      {selectedRow ? (
        <JobItems
          key={selectedRow.jobId}
          jobId={selectedRow.jobId}
          windowName={selectedRow.windowName}
          jobState={selectedRow.state}
          revision={attempt}
          onChanged={() => setAttempt((value) => value + 1)}
        />
      ) : null}
    </section>
  )
}
