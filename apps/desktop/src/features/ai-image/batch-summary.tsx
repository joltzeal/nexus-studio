import { Badge } from '@/components/ui/badge'
import type { GenerationSummary } from './types'

/** One summary per persisted submission, with every scene view kept in its parent. */
export function BatchSummary({ record }: { record: GenerationSummary }) {
  const label =
    record.purpose === 'provider-test'
      ? '模型测试'
      : record.scenePlan
        ? '多视角批次'
        : record.count > 1
          ? '多图批次'
          : '单图任务'
  const views = record.scenePlan?.views
  const completed = views
    ? views.filter((view) => view.status === 'success' && view.outputFileId !== null)
        .length
    : record.outputs.length
  const failed = views?.filter((view) => view.status === 'failed').length ?? 0
  const queued = views?.filter((view) => view.status === 'queued').length ?? 0
  const active = views?.filter((view) => view.status === 'running').length ?? 0
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{label}</Badge>
        <span>
          {views ? '已完成' : '成片'} {completed} / {record.count}
        </span>
        {failed > 0 ? <span>失败 {failed}</span> : null}
        {active > 0 ? <span>执行中 {active}</span> : null}
        {queued > 0 ? <span>等待 {queued}</span> : null}
      </div>
      <p
        className="max-w-xs truncate font-mono text-xs text-muted-foreground"
        title={record.id}
      >
        {record.scenePlan || record.count > 1 ? '批次' : '任务'} {record.id}
      </p>
    </div>
  )
}
