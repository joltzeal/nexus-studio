import { useState } from 'react'
import type { AgentJobView } from '@nexus/plugin-sdk/agent'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { navigateDetail } from '@/lib/detail-navigation'
import { getAgentBatch, listAgentItems } from './api'
import { AgentEvents } from './agent-events'
import { AgentPagination } from './agent-pagination'
import { ArtifactCover } from './artifact-cover'
import { JobItems } from './job-items'
import { recoveryHint, stageLabel } from './presentation'
import { RetryCountdown } from './retry-countdown'
import { RunControls } from './run-controls'
import {
  batchLabel,
  JOB_LABELS,
  needsAttention,
  PRESET_LABELS,
  type EventStream,
} from './state'
import { useAgentQuery } from './use-query'
import { UsagePanel } from './usage-panel'

export function BatchDetail({
  id,
  cache,
  onChanged,
  onClose,
}: {
  id: string
  cache: Map<string, EventStream>
  onChanged: () => void
  onClose: () => void
}) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [attempt, setAttempt] = useState(0)
  const [selectedJob, setSelectedJob] = useState<AgentJobView | null>(null)
  const detail = useAgentQuery(
    JSON.stringify([id, page, pageSize, attempt]),
    () => getAgentBatch(id, page, pageSize),
    2500,
  )
  const data = detail.data
  const selected = data?.jobs.find((job) => job.id === selectedJob?.id) ?? selectedJob
  function changed() {
    setAttempt((value) => value + 1)
    onChanged()
  }
  return (
    <section className="sales-agent-detail" aria-label="批次详情">
      <div className="sales-agent-toolbar">
        <strong>批次详情</strong>
        <code>{id}</code>
        <Button size="sm" variant="outline" disabled={detail.loading} onClick={changed}>
          刷新详情
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          关闭详情
        </Button>
      </div>
      {detail.loading ? <Skeleton className="h-24 w-full" /> : null}
      {detail.error ? (
        <Alert variant="destructive">
          <AlertDescription>{detail.error}</AlertDescription>
        </Alert>
      ) : null}
      {data ? (
        <>
          <div className="sales-agent-toolbar">
            <Badge variant={data.batch.attention ? 'destructive' : 'outline'}>
              {batchLabel(data.batch, data.jobs)}
            </Badge>
            <span>{PRESET_LABELS[data.batch.preset]}</span>
            <span>
              完成 {data.batch.completed} / {data.batch.total} 个窗口 · 待处理{' '}
              {data.batch.attention} · 并发 {data.batch.concurrency}
            </span>
          </div>
          <p className="sales-agent-control-help">
            核对结果：只检查已有提交。同步记录：补写已确认结果。继续执行：仅恢复可安全执行的暂停窗口。接管须等待隔离确认。
          </p>
          <RunControls
            batch={data.batch}
            jobs={data.jobs}
            stale={!!detail.error}
            onChanged={changed}
          />
          <div className="sales-agent-table">
            <Table aria-label="批次窗口作业">
              <TableHeader>
                <TableRow>
                  <TableHead>窗口 / 账号</TableHead>
                  <TableHead>状态与隔离</TableHead>
                  <TableHead>商品进度 / 当前阶段</TableHead>
                  <TableHead>原因与恢复</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() =>
                          navigateDetail({ kind: 'window', id: job.windowId })
                        }
                      >
                        {job.windowName}
                      </Button>
                      <p>
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() =>
                            navigateDetail({ kind: 'account', id: job.accountId })
                          }
                        >
                          {job.account}
                        </Button>
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge variant={needsAttention(job) ? 'destructive' : 'outline'}>
                        {JOB_LABELS[job.state]}
                      </Badge>
                      {job.takeover !== 'none' ? (
                        <p className="sales-agent-control-help" role="status">
                          {job.takeover === 'ready'
                            ? '已隔离，可人工操作'
                            : job.takeover === 'stopping'
                              ? '正在隔离，请勿人工操作'
                              : '隔离未确认，请先核对窗口'}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="sales-agent-inline">
                        {job.progress?.currentProductId ? (
                          <CurrentCover
                            jobId={job.id}
                            productId={job.progress.currentProductId}
                          />
                        ) : null}
                        <div className="sales-agent-row-copy">
                          <strong>{stageLabel(job.phase)}</strong>
                          <span>
                            {job.progress
                              ? `已发布 ${job.progress.published} · 已跳过 ${job.progress.skipped} / ${job.productCount} 件`
                              : `共 ${job.productCount} 件商品`}
                          </span>
                          {job.retry ? (
                            <span>
                              读取重试 {job.retry.attempt} / {job.retry.maxAttempts} ·{' '}
                              <RetryCountdown at={job.retry.nextAttemptAt} />
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <p className="sales-agent-job-message">{job.message || '—'}</p>
                      <p className="sales-agent-control-help">
                        {recoveryHint(job.state)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <div className="sales-agent-job-actions">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!!detail.error}
                          onClick={() => setSelectedJob(job)}
                        >
                          商品与审查
                        </Button>
                        <RunControls
                          job={job}
                          stale={!!detail.error}
                          onChanged={changed}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <AgentPagination
            label="作业"
            total={data.total}
            page={data.page}
            pageSize={pageSize}
            busy={detail.loading}
            onPage={setPage}
            onPageSize={(size) => {
              setPageSize(size)
              setPage(1)
            }}
          />
          {selected ? (
            <JobItems
              key={selected.id}
              jobId={selected.id}
              windowName={selected.windowName}
              jobState={selected.state}
              revision={attempt}
              onChanged={changed}
            />
          ) : null}
        </>
      ) : null}
      <UsagePanel id={id} revision={attempt} />
      <AgentEvents id={id} cache={cache} revision={attempt} />
    </section>
  )
}

function CurrentCover({ jobId, productId }: { jobId: string; productId: string }) {
  const item = useAgentQuery(JSON.stringify([jobId, productId]), async () => {
    const first = await listAgentItems(jobId, 1, 50)
    const found = first.items.find((item) => item.productId === productId)
    if (found || first.total <= 50) return found ?? null
    return (
      (await listAgentItems(jobId, 2, 50)).items.find(
        (item) => item.productId === productId,
      ) ?? null
    )
  })
  return (
    <ArtifactCover
      jobId={jobId}
      artifactId={item.data?.artifactId}
      title={item.data?.title || '当前商品首图'}
    />
  )
}
