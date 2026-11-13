import { describe, expect, it } from 'vitest'
import { AgentBatchCreateSchema, AgentScopeSchema, AgentSettingsSchema } from './agent.js'

const uuid = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`

describe('sales Agent boundaries', () => {
  it('rejects assigning a product or window twice', () => {
    const draft = {
      operationId: uuid(1),
      preset: 'post_listing',
      assignments: [
        { windowId: uuid(2), productIds: [uuid(4)] },
        { windowId: uuid(3), productIds: [uuid(4)] },
      ],
    }
    expect(AgentBatchCreateSchema.safeParse(draft).success).toBe(false)
    expect(
      AgentBatchCreateSchema.safeParse({
        ...draft,
        assignments: [{ windowId: uuid(2) }, { windowId: uuid(2) }],
      }).success,
    ).toBe(false)
  })

  it('keeps category optional and requires products for listing tasks', () => {
    const draft = {
      operationId: uuid(1),
      preset: 'post_listing',
      assignments: [
        {
          windowId: uuid(2),
          productIds: [uuid(3)],
          overrides: [{ productId: uuid(3), title: 'Vintage blue ceramic mug' }],
        },
      ],
    }
    expect(AgentBatchCreateSchema.parse(draft).concurrency).toBe(3)
    expect(
      AgentBatchCreateSchema.safeParse({
        ...draft,
        assignments: [{ windowId: uuid(2) }],
      }).success,
    ).toBe(false)
  })

  it('rejects an override for a product assigned elsewhere', () => {
    expect(
      AgentBatchCreateSchema.safeParse({
        operationId: uuid(1),
        preset: 'post_listing',
        assignments: [
          {
            windowId: uuid(2),
            productIds: [uuid(3)],
            overrides: [{ productId: uuid(4), price: 12 }],
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('bounds concurrency and requires explicit conversation targets', () => {
    expect(
      AgentBatchCreateSchema.safeParse({
        operationId: uuid(1),
        preset: 'message',
        concurrency: 100,
        assignments: [{ windowId: uuid(2), messages: [{ text: 'Hello' }] }],
      }).success,
    ).toBe(false)
  })

  it('requires complete model configuration and a current lease', () => {
    expect(AgentSettingsSchema.safeParse({}).success).toBe(false)
    expect(
      AgentScopeSchema.safeParse({
        batchId: uuid(1),
        jobId: uuid(2),
        windowId: uuid(3),
        accountId: uuid(4),
        leaseId: uuid(5),
        fence: 0,
      }).success,
    ).toBe(false)
  })
})
