import { describe, expect, it } from 'vitest'
import { AgentItemViewSchema } from '@nexus/plugin-sdk/agent'
import { controlReason, itemControlReason, jobControlReason } from './state'
import { batch, ids, job } from './test-data'

const item = AgentItemViewSchema.parse({
  jobId: ids.job,
  productId: ids.product,
  windowId: ids.window,
  windowName: 'Fixture',
  accountId: ids.account,
  state: 'review_required',
  originalTitle: 'Blue mug',
  originalDescription: 'A used mug.',
  title: 'Blue mug',
  description: 'My used mug.',
  submitted: false,
})

describe('per-window and unsubmitted item control eligibility', () => {
  it.each([
    'submitting',
    'published',
    'result_unknown',
    'sync_pending',
    'skipped',
    'cancelled',
    'future_state',
  ])('never permits amendments or approval for %s', (state) => {
    expect(itemControlReason({ ...item, state })).not.toBeNull()
  })
  it('requires an unsubmitted known item and retains the unknown result', () => {
    expect(itemControlReason(item)).toBeNull()
    expect(itemControlReason({ ...item, submitted: true })).not.toBeNull()
    expect(itemControlReason({ ...item, state: 'result_unknown' })).toContain('核对')
  })
  it.each(['blocked', 'completed', 'cancelled', 'skipped'] as const)(
    'keeps pending items read-only when their job is %s',
    (jobState) => {
      expect(itemControlReason(item, jobState)).not.toBeNull()
      expect(itemControlReason(item, 'review_required')).toBeNull()
    },
  )
  it('keeps controls disabled during isolation and resume limited to paused jobs', () => {
    expect(jobControlReason({ ...job, takeover: 'stopping' }, 'resume')).toContain('隔离')
    expect(jobControlReason({ ...job, state: 'result_unknown' }, 'resume')).not.toBeNull()
    expect(jobControlReason({ ...job, state: 'paused' }, 'resume')).toBeNull()
    expect(jobControlReason({ ...job, takeover: 'ready' }, 'takeover')).not.toBeNull()
  })
  it('allows takeover of active attention batches but not ended batches', () => {
    expect(
      controlReason({ ...batch, state: 'needs_attention' }, [], 'takeover'),
    ).toBeNull()
    expect(controlReason({ ...batch, state: 'completed' }, [], 'takeover')).not.toBeNull()
  })
})
