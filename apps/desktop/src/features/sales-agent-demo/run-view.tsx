import { ArrowLeft, CircleCheck, Clock3, Square } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { taskPresets } from './demo-data'
import { isJobFinished, type DemoRun } from './demo-state'
import { JobBadge } from './demo-widgets'

export function RunView({
  run,
  onBack,
  onStop,
}: {
  run: DemoRun | null
  onBack: () => void
  onStop: () => void
}) {
  if (!run) {
    return (
      <Empty className="border bg-card">
        <EmptyHeader>
          <EmptyTitle>还没有运行记录</EmptyTitle>
          <EmptyDescription>
            准备商品资料并启动一次模拟，查看按窗口分组的执行过程。
          </EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" onClick={onBack}>
          前往任务准备
        </Button>
      </Empty>
    )
  }
  const windowIds = [...new Set(run.jobs.map((job) => job.window.id))]
  const finished = run.jobs.filter(isJobFinished).length
  const completed = run.jobs.filter((job) => job.phase === 'completed').length
  const blocked = run.jobs.filter((job) => job.phase === 'blocked').length
  const skipped = run.jobs.filter((job) => job.phase === 'skipped').length

  return (
    <div className="agent-run-page">
      <div className="agent-page-heading">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="page-heading">{run.name}</h1>
            <Badge variant={run.state === 'running' ? 'default' : 'outline'}>
              {run.state === 'running'
                ? '模拟运行中'
                : run.state === 'cancelled'
                  ? '模拟已停止'
                  : '模拟已结束'}
            </Badge>
          </div>
          <p className="page-description">
            {taskPresets.find((preset) => preset.value === run.kind)?.label} ·{' '}
            {windowIds.length} 个窗口 · 最多 {run.concurrency} 个窗口并行
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={run.state === 'running'} onClick={onBack}>
            <ArrowLeft data-icon="inline-start" />
            返回编辑
          </Button>
          {run.state === 'running' ? (
            <Button variant="outline" onClick={onStop}>
              <Square data-icon="inline-start" />
              停止模拟
            </Button>
          ) : null}
        </div>
      </div>
      <section className="agent-panel" aria-label="模拟运行进度">
        <div className="agent-panel-header">
          <h2>
            <Clock3 aria-hidden="true" />
            执行进度
          </h2>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            已处理 {finished} / {run.jobs.length}
          </span>
        </div>
        <div className="agent-panel-body">
          <progress
            className="agent-progress"
            value={finished}
            max={run.jobs.length || 1}
            aria-label="模拟任务进度"
          />
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span>
              模拟完成 <strong className="text-foreground">{completed}</strong>
            </span>
            <span>
              封禁停止 <strong className="text-destructive">{blocked}</strong>
            </span>
            <span>
              检查跳过 <strong className="text-foreground">{skipped}</strong>
            </span>
            <span>同一窗口内按商品顺序执行</span>
          </div>
        </div>
      </section>
      {windowIds.map((id) => {
        const jobs = run.jobs.filter((job) => job.window.id === id)
        const window = jobs[0]!.window
        const stopped = jobs.some((job) => job.phase === 'blocked')
        return (
          <section className="agent-panel" key={id}>
            <div className="agent-panel-header">
              <h2>
                {window.name}
                <span className="text-xs font-normal text-muted-foreground">
                  @{window.account}
                </span>
              </h2>
              <Badge variant={stopped ? 'destructive' : 'outline'}>
                {stopped ? 'blocked · 该账号已停止' : window.provider}
              </Badge>
            </div>
            <Table aria-label={`${window.name}执行任务`}>
              <TableHeader>
                <TableRow>
                  <TableHead>任务</TableHead>
                  <TableHead className="w-32">状态</TableHead>
                  <TableHead>执行详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow
                    key={job.id}
                    className={
                      job.phase === 'checking' || job.phase === 'executing'
                        ? 'agent-row-running'
                        : undefined
                    }
                  >
                    <TableCell className="w-72">
                      {job.product?.label ??
                        (run.kind === 'message'
                          ? '读取未读消息并回复'
                          : '检查账号资料与余额')}
                    </TableCell>
                    <TableCell>
                      <JobBadge phase={job.phase} />
                    </TableCell>
                    <TableCell className="whitespace-normal text-xs text-muted-foreground">
                      {job.detail}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        )
      })}
      <section className="agent-panel">
        <div className="agent-panel-header">
          <h2>
            <CircleCheck aria-hidden="true" />
            执行日志
          </h2>
          <span className="text-xs text-muted-foreground">仅模拟事件</span>
        </div>
        <ol className="agent-event-list" aria-live="polite">
          {run.events.map((event, index) => (
            <li key={index}>
              <span className="font-mono text-muted-foreground">
                {String(index + 1).padStart(2, '0')}
              </span>
              {event}
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
