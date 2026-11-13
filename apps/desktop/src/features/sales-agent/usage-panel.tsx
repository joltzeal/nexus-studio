import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { getAgentUsage, listAgentModelRequests } from './api'
import { AgentPagination } from './agent-pagination'
import { moneyLabel } from './presentation'
import { useAgentQuery } from './use-query'

const NOTIFICATIONS = {
  disabled: '通知未开启',
  pending: '通知待发送',
  sent: '通知已发送',
  failed: '通知发送失败',
  none: '暂无通知',
}

export function UsagePanel({ id, revision }: { id: string; revision: number }) {
  const [attempt, setAttempt] = useState(0)
  const result = useAgentQuery(
    JSON.stringify([id, revision, attempt]),
    () => getAgentUsage(id),
    5000,
  )
  return (
    <section className="sales-agent-usage" aria-label="模型用量与预算">
      <div className="sales-agent-toolbar">
        <strong>模型用量与预算</strong>
        <Button
          size="sm"
          variant="ghost"
          disabled={result.loading}
          onClick={() => setAttempt((value) => value + 1)}
        >
          刷新用量
        </Button>
      </div>
      {result.error ? (
        <Alert variant="destructive">
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      ) : null}
      {result.data ? (
        <>
          <dl className="sales-agent-metrics">
            <div>
              <dt>模型请求</dt>
              <dd>
                {result.data.requests} / {result.data.maxRequests}
              </dd>
            </div>
            <div>
              <dt>请求结果</dt>
              <dd>
                成功 {result.data.succeeded} · 失败 {result.data.failed}
              </dd>
            </div>
            <div>
              <dt>累计耗时</dt>
              <dd>{(result.data.elapsedMs / 1000).toFixed(1)} 秒</dd>
            </div>
            <div>
              <dt>已知 Token</dt>
              <dd>
                输入 {result.data.inputTokens} · 输出 {result.data.outputTokens}
              </dd>
            </div>
            <div>
              <dt>估算费用</dt>
              <dd>{moneyLabel(result.data.estimatedCostUsd)}</dd>
            </div>
            <div>
              <dt>费用预算</dt>
              <dd>
                {result.data.maxCostUsd === null
                  ? '未设置'
                  : moneyLabel(result.data.maxCostUsd)}
              </dd>
            </div>
          </dl>
          <div className="sales-agent-toolbar">
            <Badge
              variant={result.data.notification === 'failed' ? 'destructive' : 'outline'}
            >
              {NOTIFICATIONS[result.data.notification]}
            </Badge>
            <span className="text-muted-foreground">
              用量未知的请求 {result.data.unknownUsage}{' '}
              次；估算费用按已配置价格计算，已消费费用无法撤回。
            </span>
          </div>
        </>
      ) : result.loading ? (
        <p className="sales-agent-control-help">正在读取用量…</p>
      ) : null}
      <ModelRequestHistory id={id} revision={revision + attempt} />
    </section>
  )
}

const REQUEST_STATES = {
  active: '进行中',
  unknown: '回执未知',
  succeeded: '已成功',
  failed: '失败',
  cancelled: '已取消',
} as const

export function ModelRequestHistory({ id, revision }: { id: string; revision: number }) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [attempt, setAttempt] = useState(0)
  const result = useAgentQuery(
    JSON.stringify([id, page, pageSize, revision, attempt]),
    () => listAgentModelRequests(id, page, pageSize),
    5000,
  )
  return (
    <section className="sales-agent-items" aria-label="模型请求明细">
      <div className="sales-agent-toolbar">
        <strong>模型请求明细</strong>
        <Button
          size="sm"
          variant="ghost"
          disabled={result.loading}
          onClick={() => setAttempt((value) => value + 1)}
        >
          刷新请求明细
        </Button>
      </div>
      <p className="sales-agent-control-help">
        每条请求仅展示执行摘要。回执或用量未知不等于零费用；状态以最新任务记录为准。
      </p>
      {result.error ? (
        <Alert variant="destructive">
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      ) : null}
      {result.loading ? <Skeleton className="h-24 w-full" /> : null}
      {result.data ? (
        <>
          <div className="sales-agent-table">
            <Table aria-label="模型请求分页摘要">
              <TableHeader>
                <TableRow>
                  <TableHead>模型 / 请求</TableHead>
                  <TableHead>状态 / HTTP</TableHead>
                  <TableHead>开始时间</TableHead>
                  <TableHead>耗时</TableHead>
                  <TableHead>Token 用量</TableHead>
                  <TableHead>估算费用</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.items.map((request) => (
                  <TableRow key={request.requestId}>
                    <TableCell>
                      <strong>
                        {request.kind === 'decision' ? '结构化判断' : '识图与英文文案'}
                      </strong>
                      <p className="sales-agent-control-help" title={request.requestId}>
                        请求 {request.requestId.slice(0, 8)}
                      </p>
                      <p className="sales-agent-control-help" title={request.jobId}>
                        作业 {request.jobId.slice(0, 8)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          request.state === 'unknown' || request.state === 'failed'
                            ? 'destructive'
                            : 'outline'
                        }
                      >
                        {REQUEST_STATES[request.state]}
                      </Badge>
                      <p className="sales-agent-control-help">
                        {request.status === null ? '—' : `HTTP ${request.status}`}
                      </p>
                    </TableCell>
                    <TableCell>
                      <time dateTime={request.startedAt}>
                        {new Date(request.startedAt).toLocaleString()}
                      </time>
                    </TableCell>
                    <TableCell>{(request.elapsedMs / 1000).toFixed(1)} 秒</TableCell>
                    <TableCell>
                      输入 {request.inputTokens ?? '未知'} · 输出{' '}
                      {request.outputTokens ?? '未知'}
                    </TableCell>
                    <TableCell>{moneyLabel(request.estimatedCostUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {!result.data.items.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>暂无模型请求记录</EmptyTitle>
                <EmptyDescription>
                  此批次取得模型调用许可后，会在这里记录请求摘要。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          <AgentPagination
            label="模型请求"
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
    </section>
  )
}
