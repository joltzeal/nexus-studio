import type {
  AgentBatchView,
  AgentEvent,
  AgentEventPage,
  AgentJobView,
  AgentItemView,
} from '@nexus/plugin-sdk/agent'
import type { AgentControl } from './api'

export const PRESET_LABELS = {
  post_listing: 'Post Listing · 商品上架',
  inspect_accounts: 'Account Check · 账号检查',
  message: 'Message · 指定会话消息',
}

export const JOB_LABELS: Record<AgentJobView['state'], string> = {
  queued: '排队中',
  running: '执行中',
  paused: '已暂停',
  completed: '已完成',
  blocked: '账号封禁 · 已阻断',
  review_required: '等待人工检查',
  result_unknown: '结果不明 · 待核对',
  sync_pending: '结果已确认 · 记录待同步',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已跳过',
}

const BATCH_LABELS: Record<AgentBatchView['state'], string> = {
  queued: '排队中',
  running: '执行中',
  paused: '已暂停',
  completed: '已完成',
  needs_attention: '需要处理',
  cancelled: '已取消',
}

export function needsAttention(job: AgentJobView): boolean {
  return [
    'blocked',
    'review_required',
    'result_unknown',
    'sync_pending',
    'failed',
  ].includes(job.state)
}

export function batchLabel(
  batch: AgentBatchView,
  jobs: readonly AgentJobView[] = [],
): string {
  if (batch.attention > 0 || jobs.some(needsAttention)) return '需要处理'
  return BATCH_LABELS[batch.state]
}

export function controlReason(
  batch: AgentBatchView,
  jobs: readonly AgentJobView[],
  action: AgentControl,
): string | null {
  if (action === 'reconcile') return null
  if (action === 'takeover')
    return batch.state === 'completed' || batch.state === 'cancelled'
      ? '此批次已结束。'
      : null
  if (action === 'pause') {
    if (batch.state === 'running' || batch.state === 'queued') return null
    if (batch.state === 'needs_attention') {
      if (jobs.some((job) => job.state === 'queued' || job.state === 'running'))
        return null
      const inactiveOnPage = jobs.filter(
        (job) => job.state === 'paused' || job.state === 'cancelled',
      ).length
      // The summary can hide queued siblings; leave unseen eligibility to native.
      if (
        jobs.length < batch.total &&
        batch.total > batch.completed + batch.attention + inactiveOnPage
      )
        return null
    }
    return '只有排队或执行中的窗口可以暂停。'
  }
  if (action === 'cancel')
    return batch.state === 'completed' || batch.state === 'cancelled'
      ? '此批次已结束；需关注的结果仍可核对。'
      : null
  if (batch.state === 'completed' || batch.state === 'cancelled')
    return '此批次已结束；需关注的结果仍可核对。'
  if (
    jobs.some((job) => job.state === 'paused') ||
    // A needs-attention batch can have healthy paused siblings on another page.
    (jobs.length < batch.total &&
      (batch.state === 'paused' || batch.state === 'needs_attention') &&
      batch.total > batch.completed + batch.attention)
  )
    return null
  if (
    batch.attention > 0 ||
    jobs.some(needsAttention) ||
    batch.state === 'needs_attention'
  )
    return '当前没有可继续的暂停窗口，请先核对待处理结果。'
  return batch.state === 'paused' ? null : '只有可安全执行的已暂停窗口可以继续。'
}

export function jobControlReason(
  job: AgentJobView,
  action: Exclude<AgentControl, 'reconcile'>,
): string | null {
  if (job.state === 'completed' || job.state === 'cancelled' || job.state === 'skipped')
    return '此窗口任务已结束。'
  if (job.takeover === 'stopping') return '正在隔离窗口，请等待接管状态确认。'
  if (action === 'takeover')
    return job.takeover === 'ready' ? '已完成隔离，可人工操作。' : null
  if (action === 'resume')
    return job.state === 'paused' ? null : '仅可继续可安全执行的已暂停窗口。'
  if (action === 'pause')
    return job.state === 'queued' || job.state === 'running'
      ? null
      : '此窗口当前没有可暂停的派发。'
  return null
}

export function itemControlReason(
  item: AgentItemView,
  jobState?: AgentJobView['state'],
): string | null {
  if (jobState === 'blocked') return '此窗口任务已阻断，请先核对原因和账号状态。'
  if (jobState && ['completed', 'cancelled', 'skipped'].includes(jobState))
    return '此窗口任务已结束，商品资料仅供查看。'
  if (
    item.submitted ||
    ['submitting', 'published', 'result_unknown', 'sync_pending'].includes(item.state)
  )
    return '已有提交或待核对结果，只能核对结果或同步记录。'
  if (['skipped', 'cancelled'].includes(item.state)) return '此商品任务已结束。'
  return ['pending', 'reviewing', 'preparing', 'review_required', 'failed'].includes(
    item.state,
  )
    ? null
    : '当前商品状态不支持修订或继续，请先刷新核对。'
}

export interface EventStream {
  cursor: number
  items: AgentEvent[]
  hasMore: boolean
}

export function emptyEventStream(): EventStream {
  return { cursor: 0, items: [], hasMore: false }
}

export function appendEvents(current: EventStream, page: AgentEventPage): EventStream {
  if (page.cursor < current.cursor) return current
  const bySequence = new Map(current.items.map((event) => [event.sequence, event]))
  for (const event of page.items) {
    if (event.sequence > current.cursor) bySequence.set(event.sequence, event)
  }
  return {
    cursor: page.cursor,
    items: [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-500),
    hasMore: page.hasMore,
  }
}

/** Each independent query owns a generation; stale success and failure are ignored. */
export class RequestScope {
  private revision = 0

  begin(): () => boolean {
    const revision = ++this.revision
    return () => this.revision === revision
  }

  invalidate(): void {
    this.revision += 1
  }
}
