import { describe, expect, it } from 'vitest'
import {
  addDraftProducts,
  assignDraftProducts,
  batchInput,
  BatchSubmission,
  draftProblems,
  emptyAgentDraft,
  englishText,
  parseProductEdits,
  removeDraftProduct,
  setDraftWindows,
} from './assignment'
import { ids, product, target } from './test-data'

function draft() {
  return assignDraftProducts(
    setDraftWindows(addDraftProducts(emptyAgentDraft(), [product]), [ids.window]),
    [product.id],
    ids.window,
  )
}

describe('real product and window assignments', () => {
  it('retains operation identity across lost replies and changes it only when submitted form changes', () => {
    const submission = new BatchSubmission()
    const initial = submission.prepare(draft(), [target])
    expect(submission.prepare(draft(), [target]).operationId).toBe(initial.operationId)
    const updated = submission.prepare(
      { ...draft(), instruction: 'Keep the existing price.' },
      [target],
    )
    expect(updated.operationId).not.toBe(initial.operationId)
    expect(
      submission.prepare({ ...draft(), instruction: 'Keep the existing price.' }, [
        target,
      ]).operationId,
    ).toBe(updated.operationId)
  })
  it('deduplicates product identity without replacing edits or the picked revision', () => {
    const initial = {
      ...draft(),
      overrides: { [product.id]: { productId: product.id, price: 18 } },
    }
    const next = addDraftProducts(initial, [{ ...product, revision: 9 }])
    expect(next.products).toHaveLength(1)
    expect(next.products[0]?.revision).toBe(1)
    expect(batchInput(next, [target], ids.operation).assignments[0]).toMatchObject({
      productIds: [product.id],
      overrides: [{ productId: product.id, price: 18 }],
    })
  })

  it('moves only explicitly assigned products and unassigns when a window is removed', () => {
    const initial = setDraftWindows(draft(), [ids.window, ids.otherWindow])
    const moved = assignDraftProducts(initial, [ids.product], ids.otherWindow)
    expect(moved.assignments).toEqual({ [ids.product]: ids.otherWindow })
    const removed = setDraftWindows(moved, [ids.window])
    expect(removed.assignments).toEqual({})
    expect(removed.products).toEqual([product])
    expect(draftProblems(removed, [target]).join(' ')).toContain('未分配')
    expect(initial.assignments).toEqual({ [ids.product]: ids.window })
  })

  it('rejects foreign drag data and assignment to a window outside the selection', () => {
    expect(() => assignDraftProducts(draft(), [ids.job], ids.window)).toThrow('不属于')
    expect(() => assignDraftProducts(draft(), [ids.product], ids.otherWindow)).toThrow(
      '先选择',
    )
    expect(removeDraftProduct(draft(), product.id).assignments).toEqual({})
  })

  it('keeps optional category and brand empty and builds the exact public input', () => {
    const input = batchInput(draft(), [target], ids.operation)
    expect(input).toEqual({
      operationId: ids.operation,
      preset: 'post_listing',
      instruction: '',
      concurrency: 3,
      assignments: [
        { windowId: ids.window, productIds: [ids.product], overrides: [], messages: [] },
      ],
    })
    expect(
      parseProductEdits(product.id, {
        title: 'Used mug',
        description: 'Original finish.',
        price: '12.50',
        condition: 'Good',
        category: '',
        brand: '',
        size: '',
      }),
    ).toMatchObject({
      productId: ids.product,
      price: 12.5,
      category: '',
      brand: '',
      size: '',
    })
  })

  it.each(['', ' ', '0', '-5', 'NaN', '1e999'])(
    'rejects an invalid override price %j',
    (price) => {
      expect(() => parseProductEdits(product.id, { price })).toThrow('正数价格')
    },
  )

  it('prevents creation for blocked, missing and unknown targets without silently dropping them', () => {
    const blocked = { ...target, unavailable: '账号已封禁（blocked）' }
    expect(() => batchInput(draft(), [blocked], ids.operation)).toThrow('blocked')
    expect(() => batchInput(draft(), [], ids.operation)).toThrow('不在当前列表')
    expect(draft().windowIds).toEqual([ids.window])
  })

  it('rejects a previously published product and incomplete listing material', () => {
    const current = {
      ...draft(),
      products: [{ ...product, publicationCount: 1, images: [], condition: '' }],
    }
    const problems = draftProblems(current, [target]).join(' ')
    expect(problems).toContain('禁止重复上架')
    expect(problems).toContain('缺少图片')
    expect(problems).toContain('缺少成色')
  })

  it('requires each window to specify a conversation and English message', () => {
    const current = { ...draft(), preset: 'message' as const, messages: {} }
    expect(draftProblems(current, [target]).join(' ')).toContain('conversationId')
    current.messages = {
      [ids.window]: {
        conversationId: '123',
        text: 'Hello, is there anything else you need?',
      },
    }
    expect(batchInput(current, [target], ids.operation).assignments).toEqual([
      {
        windowId: ids.window,
        productIds: [],
        overrides: [],
        messages: [
          { conversationId: '123', text: 'Hello, is there anything else you need?' },
        ],
      },
    ])
    expect(englishText('你好 Hello')).toBe(false)
    expect(englishText('123 👍')).toBe(false)
    expect(englishText('Hello — the café mug is available.')).toBe(true)
  })

  it('does not send leftover products or messages for inspect_accounts', () => {
    const current = {
      ...draft(),
      preset: 'inspect_accounts' as const,
      messages: { [ids.window]: { conversationId: '123', text: 'Hello' } },
    }
    expect(batchInput(current, [target], ids.operation).assignments).toEqual([
      {
        windowId: ids.window,
        productIds: [],
        overrides: [],
        messages: [],
      },
    ])
  })

  it('supports selecting 100 windows and rejects the 101st without losing earlier choices', () => {
    const windows = Array.from({ length: 100 }, (_, index) => `window-${index}`)
    const current = setDraftWindows(emptyAgentDraft(), windows)
    expect(current.windowIds).toHaveLength(100)
    expect(() => setDraftWindows(current, [...windows, 'overflow'])).toThrow('100')
    expect(current.windowIds).toHaveLength(100)
  })
})
