import { AgentSavedPlanSchema } from '@nexus/plugin-sdk/agent'
import { describe, expect, it } from 'vitest'
import { assignDraftProducts, emptyAgentDraft, setDraftWindows } from './assignment'
import { ids, now, product } from './test-data'
import { draftFromPlan, planFromDraft, workspaceSaveOutcome } from './workspace-state'

describe('durable draft relationships and lost replies', () => {
  const draft = {
    ...emptyAgentDraft(),
    products: [product],
    windowIds: [ids.window],
    assignments: { [ids.product]: ids.window },
    overrides: { [ids.product]: { productId: ids.product, title: 'Edited mug' } },
  }
  it('stores only stable IDs and editing values, then uses refreshed product facts', () => {
    const plan = planFromDraft(draft)
    expect(JSON.stringify(plan)).not.toContain('sha256')
    expect(plan.productIds).toEqual([ids.product])
    const restored = draftFromPlan(plan, [
      { ...product, revision: 8, publicationCount: 1 },
    ])
    expect(restored.products[0]?.revision).toBe(8)
    expect(restored.products[0]?.publicationCount).toBe(1)
    expect(restored.overrides[ids.product]?.title).toBe('Edited mug')
    expect(plan.unassignedOverrides).toEqual([])
  })
  it('saves product edits before any window or assignment is selected', () => {
    const plan = planFromDraft({ ...draft, windowIds: [], assignments: {} })
    expect(plan.assignments).toEqual([])
    expect(plan.unassignedOverrides).toEqual([
      { productId: ids.product, title: 'Edited mug' },
    ])
    expect(plan.productIds).toEqual([ids.product])
    expect(JSON.stringify(plan)).not.toContain('sha256')
    expect(draft.overrides[ids.product]?.title).toBe('Edited mug')
  })
  it('moves edits between assigned and unassigned storage as window selection changes', () => {
    const unassigned = { ...draft, assignments: {} }
    const assigned = assignDraftProducts(unassigned, [ids.product], ids.window)
    const assignedPlan = planFromDraft(assigned)
    expect(assignedPlan.unassignedOverrides).toEqual([])
    expect(assignedPlan.assignments[0]?.overrides).toEqual([
      { productId: ids.product, title: 'Edited mug' },
    ])
    const clearedPlan = planFromDraft(setDraftWindows(assigned, []))
    expect(clearedPlan.assignments).toEqual([])
    expect(clearedPlan.unassignedOverrides).toEqual([
      { productId: ids.product, title: 'Edited mug' },
    ])
  })
  it('stores only unassigned edits at the root alongside assigned edits', () => {
    const plan = planFromDraft({
      ...draft,
      products: [product, { ...product, id: ids.image }],
      overrides: {
        ...draft.overrides,
        [ids.image]: { productId: ids.image, price: 24, brand: '' },
      },
    })
    expect(plan.assignments[0]?.productIds).toEqual([ids.product])
    expect(plan.assignments[0]?.overrides).toEqual([
      { productId: ids.product, title: 'Edited mug' },
    ])
    expect(plan.unassignedOverrides).toEqual([
      { productId: ids.image, price: 24, brand: '' },
    ])
  })
  it('merges assigned and unassigned edits over refreshed source products', () => {
    const plan = AgentSavedPlanSchema.parse({
      preset: 'post_listing',
      productIds: [ids.product, ids.image],
      windowIds: [ids.window],
      assignments: [
        {
          windowId: ids.window,
          productIds: [ids.product],
          overrides: [{ productId: ids.product, title: 'Edited mug' }],
        },
      ],
      unassignedOverrides: [{ productId: ids.image, price: 24, brand: '' }],
    })
    const refreshed = [
      { ...product, revision: 8, publicationCount: 1 },
      { ...product, id: ids.image, revision: 9, title: 'Updated source title' },
    ]
    const restored = draftFromPlan(plan, refreshed)
    expect(restored.products).toEqual(refreshed)
    expect(restored.assignments).toEqual({ [ids.product]: ids.window })
    expect(restored.overrides).toEqual({
      [ids.product]: { productId: ids.product, title: 'Edited mug' },
      [ids.image]: { productId: ids.image, price: 24, brand: '' },
    })
    expect(() => draftFromPlan(plan, refreshed.slice(0, 1))).toThrow('商品')
  })
  it('still rejects a multi-message window instead of partially loading its plan', () => {
    const plan = planFromDraft(draft)
    plan.assignments[0]!.messages = [
      { conversationId: '1', text: 'First message' },
      { conversationId: '2', text: 'Second message' },
    ]
    expect(() => draftFromPlan(plan, [product])).toThrow('多条消息')
  })
  it('does not partially load a plan after a source product disappeared', () => {
    expect(() => draftFromPlan(planFromDraft(draft), [])).toThrow('商品')
  })
  it('confirms a lost save only from the exact next revision and matching content', () => {
    const input = {
      id: ids.operation,
      kind: 'draft' as const,
      name: 'Saved mug',
      expectedRevision: 2,
      data: planFromDraft(draft),
    }
    const entry = { ...input, revision: 3, createdAt: now, updatedAt: now }
    expect(workspaceSaveOutcome(input, entry)).toBe('saved')
    expect(workspaceSaveOutcome(input, { ...entry, revision: 2 })).toBe('not_saved')
    expect(workspaceSaveOutcome(input, { ...entry, name: 'Other edits' })).toBe(
      'conflict',
    )
    expect(workspaceSaveOutcome(input, { ...entry, revision: 4 })).toBe('conflict')
  })
})
