import { describe, expect, it } from 'vitest'
import {
  AgentControlsSchema,
  AgentItemControlSchema,
  AgentModelAcquireSchema,
  AgentModelCompleteSchema,
  AgentModelRequestPageSchema,
  AgentNotificationSchema,
  AgentSavedPlanSchema,
  AgentSettingsSchema,
  AgentWorkspaceSaveSchema,
} from './agent.js'

const id = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const endpoint = { baseUrl: 'https://model.example/v1', apiKey: 'fixture', model: 'test' }

describe('sales Agent completion boundaries', () => {
  it('keeps provider/model limits and retention explicit, with notifications disabled', () => {
    const settings = AgentSettingsSchema.parse({
      decision: endpoint,
      generation: endpoint,
    })
    expect(settings.execution.modelConcurrency).toBe(3)
    expect(settings.execution.maxReadRetries).toBe(2)
    expect(settings.notifications.enabled).toBe(false)
    expect(settings.retention.enabled).toBe(false)
    expect(settings.execution.maxBatchCostUsd).toBeNull()
  })

  it('rejects cost budgets without complete prices and enabled notifications without a key', () => {
    expect(
      AgentSettingsSchema.safeParse({
        decision: endpoint,
        generation: endpoint,
        execution: { maxBatchCostUsd: 5 },
      }).success,
    ).toBe(false)
    expect(
      AgentSettingsSchema.safeParse({
        decision: endpoint,
        generation: endpoint,
        notifications: { enabled: true },
      }).success,
    ).toBe(false)
  })

  it('stores incomplete drafts without embedding credentials, images or duplicate relationships', () => {
    const data = { preset: 'post_listing', productIds: [id], windowIds: [other] }
    expect(AgentSavedPlanSchema.parse(data).assignments).toEqual([])
    expect(
      AgentSavedPlanSchema.safeParse({ ...data, settings: { apiKey: 'secret' } }).success,
    ).toBe(false)
    expect(
      AgentSavedPlanSchema.safeParse({
        ...data,
        assignments: [
          { windowId: other, productIds: [id] },
          { windowId: other, productIds: [id] },
        ],
      }).success,
    ).toBe(false)
    expect(
      AgentSavedPlanSchema.safeParse({
        ...data,
        assignments: [{ windowId: other, productIds: [other] }],
      }).success,
    ).toBe(false)
  })

  it('requires optimistic revisions for workspace writes and bounded item amendments', () => {
    expect(
      AgentWorkspaceSaveSchema.safeParse({
        id,
        kind: 'draft',
        name: 'Draft',
        expectedRevision: 0,
        data: { preset: 'post_listing' },
      }).success,
    ).toBe(true)
    expect(
      AgentWorkspaceSaveSchema.safeParse({
        id,
        kind: 'draft',
        name: 'Draft',
        expectedRevision: -1,
        data: { preset: 'post_listing' },
      }).success,
    ).toBe(false)
    expect(
      AgentItemControlSchema.safeParse({ jobId: id, productId: other, action: 'revise' })
        .success,
    ).toBe(false)
    expect(
      AgentItemControlSchema.safeParse({
        jobId: id,
        productId: other,
        action: 'revise',
        override: { title: 'Corrected title' },
      }).success,
    ).toBe(true)
    expect(
      AgentControlsSchema.safeParse({
        revision: 1,
        items: [{ productId: id, revision: 2, action: 'skip' }],
      }).success,
    ).toBe(false)
  })

  it('bounds saved plan messages in aggregate and measures the UTF-8 payload size', () => {
    const windows = [id, other]
    expect(
      AgentSavedPlanSchema.safeParse({
        preset: 'message',
        windowIds: windows,
        assignments: windows.map((windowId) => ({
          windowId,
          messages: Array.from({ length: 51 }, (_, index) => ({
            conversationId: String(index + 1),
            text: 'Hello',
          })),
        })),
      }).success,
    ).toBe(false)
    const products = Array.from(
      { length: 100 },
      (_, index) => `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    )
    expect(
      AgentSavedPlanSchema.safeParse({
        preset: 'post_listing',
        productIds: products,
        windowIds: [id],
        assignments: [
          {
            windowId: id,
            productIds: products,
            overrides: products.map((productId) => ({
              productId,
              description: '\u4e00'.repeat(6000),
            })),
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('preserves edited products in incomplete drafts without duplicating assigned overrides', () => {
    const data = {
      preset: 'post_listing',
      productIds: [id],
      windowIds: [other],
      unassignedOverrides: [{ productId: id, title: 'Edited before assigning' }],
    }
    expect(AgentSavedPlanSchema.safeParse(data).success).toBe(true)
    expect(
      AgentSavedPlanSchema.safeParse({
        ...data,
        unassignedOverrides: [{ productId: other, title: 'Missing source' }],
      }).success,
    ).toBe(false)
    expect(
      AgentSavedPlanSchema.safeParse({
        ...data,
        assignments: [{ windowId: other, productIds: [id] }],
      }).success,
    ).toBe(false)
    expect(
      AgentSavedPlanSchema.safeParse({
        ...data,
        unassignedOverrides: [...data.unassignedOverrides, ...data.unassignedOverrides],
      }).success,
    ).toBe(false)
  })

  it('keeps model requests scoped and rejects unbounded or negative usage', () => {
    expect(
      AgentModelAcquireSchema.safeParse({ requestId: id, kind: 'generation' }).success,
    ).toBe(true)
    expect(
      AgentModelAcquireSchema.safeParse({
        requestId: id,
        kind: 'generation',
        baseUrl: 'https://other.example',
      }).success,
    ).toBe(false)
    expect(
      AgentModelCompleteSchema.safeParse({
        requestId: id,
        outcome: 'succeeded',
        elapsedMs: 200,
        inputTokens: -1,
      }).success,
    ).toBe(false)
  })

  it('exposes bounded model-request summaries without endpoints or request bodies', () => {
    const page = {
      batchId: id,
      items: [
        {
          requestId: other,
          jobId: id,
          kind: 'generation',
          state: 'unknown',
          startedAt: '2026-11-13T01:02:03.004Z',
          elapsedMs: 20,
          inputTokens: null,
          outputTokens: null,
          estimatedCostUsd: null,
          status: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    }
    expect(AgentModelRequestPageSchema.safeParse(page).success).toBe(true)
    expect(
      AgentModelRequestPageSchema.safeParse({
        ...page,
        items: [{ ...page.items[0], apiKey: 'fixture-private-key' }],
      }).success,
    ).toBe(false)
    expect(
      AgentModelRequestPageSchema.safeParse({
        ...page,
        items: [{ ...page.items[0], estimatedCostUsd: -1 }],
      }).success,
    ).toBe(false)
  })

  it('rejects an accumulated control envelope that exceeds the host byte budget', () => {
    expect(
      AgentControlsSchema.safeParse({
        revision: 100,
        items: Array.from({ length: 100 }, (_, index) => ({
          productId: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
          action: 'revise',
          revision: index + 1,
          override: { description: '\u4e00'.repeat(6000) },
        })),
      }).success,
    ).toBe(false)
  })

  it('bounds notification content and accepts only the configured batch notification kinds', () => {
    const notification = {
      notificationId: id,
      batchId: other,
      kind: 'completed',
      settings: { enabled: true, deviceKey: 'fixture-bark-key' },
      title: 'Batch finished',
      body: 'Published 2 items.',
    }
    expect(AgentNotificationSchema.safeParse(notification).success).toBe(true)
    expect(
      AgentNotificationSchema.safeParse({ ...notification, body: 'x'.repeat(4001) })
        .success,
    ).toBe(false)
    expect(
      AgentNotificationSchema.safeParse({ ...notification, kind: 'every_step' }).success,
    ).toBe(false)
  })
})
