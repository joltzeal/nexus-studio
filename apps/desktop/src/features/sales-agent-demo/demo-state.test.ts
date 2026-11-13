import { describe, expect, it } from 'vitest'
import {
  addProducts,
  assignProducts,
  completeProducts,
  createDemoDraft,
  createDemoRun,
  missingFields,
  planErrors,
  reviewProducts,
  setDemoWindowCount,
  setSelectedWindows,
  stopDemoRun,
  tickDemoRun,
  updateProduct,
} from './demo-state'

function preparedDraft() {
  const draft = createDemoDraft()
  return { ...draft, products: reviewProducts(completeProducts(draft.products)) }
}

describe('sales Agent interactive prototype', () => {
  it('does not require a category when listing details are otherwise complete', () => {
    const product = { ...preparedDraft().products[0]!, category: '' }
    expect(missingFields(product)).toEqual([])
  })
  it('deduplicates source products and clears assignments when removing windows', () => {
    const draft = createDemoDraft()
    const added = addProducts(draft, [
      'demo-product-01',
      'demo-product-05',
      'demo-product-05',
    ])
    expect(added.products.map((product) => product.id)).toHaveLength(5)
    const changed = setSelectedWindows(added, ['demo-window-01'])
    expect(
      changed.products.find((product) => product.id === 'demo-product-02')?.windowId,
    ).toBeNull()
    expect(changed.products[0]?.windowId).toBe('demo-window-01')
  })

  it('moves a batch to exactly one selected window without changing the source draft', () => {
    const draft = createDemoDraft()
    const moved = assignProducts(
      draft,
      ['demo-product-01', 'demo-product-02', 'demo-product-01', 'missing'],
      'demo-window-03',
    )
    expect(moved.products.slice(0, 2).map((product) => product.windowId)).toEqual([
      'demo-window-03',
      'demo-window-03',
    ])
    expect(draft.products[0]?.windowId).toBe('demo-window-01')
    expect(moved.products[2]).toBe(draft.products[2])
    expect(moved.products).toHaveLength(4)
  })

  it('rejects an unselected target and returns selected products to the unassigned list', () => {
    const draft = createDemoDraft()
    expect(assignProducts(draft, ['demo-product-01'], 'demo-window-04')).toBe(draft)
    expect(assignProducts(draft, ['demo-product-01'], 'missing')).toBe(draft)
    const moved = assignProducts(draft, ['demo-product-01', 'demo-product-02'], null)
    expect(moved.products.slice(0, 2).every((product) => product.windowId === null)).toBe(
      true,
    )
    expect(planErrors(moved, 'listing', 'Test', 'Post items')).toContain(
      '2 件商品尚未分配窗口。',
    )
  })

  it('keeps stable window identities at 100 windows and unassigns removed demo targets', () => {
    const initial = createDemoDraft()
    const expanded = setDemoWindowCount(initial, 100)
    expect(expanded.windows).toHaveLength(100)
    expect(new Set(expanded.windowIds).size).toBe(100)
    expect(expanded.windows[0]).toEqual(initial.windows[0])
    const moved = assignProducts(expanded, ['demo-product-01'], 'demo-window-100')
    const reduced = setDemoWindowCount(moved, 4)
    expect(reduced.windowIds).toHaveLength(4)
    expect(reduced.products[0]?.windowId).toBeNull()
    expect(reduced.products[1]?.windowId).toBe('demo-window-02')
    expect(setDemoWindowCount(reduced, 100).windows).toEqual(expanded.windows)
  })

  it('only fills missing data and preserves manual text and completed review', () => {
    const draft = createDemoDraft()
    const product = { ...draft.products[2]!, title: 'My blue mug', price: '15' }
    const [filled] = completeProducts([product])
    expect(filled?.title).toBe('My blue mug')
    expect(filled?.price).toBe('15')
    expect(filled?.description).not.toBe('')
    const reviewed = reviewProducts([filled!])
    expect(completeProducts(reviewed)).toEqual(reviewed)
  })

  it('keeps revised text consistent with edited attributes and preserves manual copy', () => {
    const product = { ...createDemoDraft().products[1]!, brand: 'Unbranded', size: 'L' }
    const [reviewed] = reviewProducts([product])
    expect(reviewed?.title).toBe('Beige knit cardigan, size L')
    expect(reviewed?.description).not.toContain('H&M')
    const manual = updateProduct(product, {
      title: 'My beige cardigan',
      description: 'Worn twice, no stains. Selling as it no longer fits.',
    })
    expect(reviewProducts([manual])[0]?.title).toBe('My beige cardigan')
  })

  it('blocks an incomplete or unassigned listing plan', () => {
    expect(planErrors(createDemoDraft(), 'listing', 'Test', 'Post items')).toEqual(
      expect.arrayContaining([
        '1 件商品资料未完整，请补全或编辑。',
        '4 件商品尚未完成运行前检查。',
      ]),
    )
    const draft = preparedDraft()
    expect(planErrors(draft, 'listing', 'Test', 'Post items')).toEqual([])
    draft.products[0]!.windowId = null
    expect(planErrors(draft, 'listing', 'Test', 'Post items')).toContain(
      '1 件商品尚未分配窗口。',
    )
  })

  it('stops a blocked account and skips rejected images while other accounts finish', () => {
    const draft = preparedDraft()
    let run = createDemoRun(draft, 'listing', 'Test', 'Post items', 2)
    for (let tick = 0; tick < 12; tick += 1) run = tickDemoRun(run)
    expect(run.state).toBe('completed')
    expect(run.jobs.filter((job) => job.phase === 'completed')).toHaveLength(2)
    expect(run.jobs.find((job) => job.product?.id === 'demo-product-03')?.phase).toBe(
      'blocked',
    )
    expect(run.jobs.find((job) => job.product?.id === 'demo-product-04')?.phase).toBe(
      'skipped',
    )
  })

  it('uses an immutable draft snapshot and one active task per window', () => {
    const draft = preparedDraft()
    let run = createDemoRun(draft, 'listing', 'Test', 'Post items', 2)
    draft.products[0]!.title = 'Changed after launch'
    expect(run.jobs[0]?.product?.title).not.toBe('Changed after launch')
    for (let tick = 0; tick < 12; tick += 1) {
      run = tickDemoRun(run)
      const active = run.jobs.filter(
        (job) => job.phase === 'checking' || job.phase === 'executing',
      )
      expect(active.length).toBeLessThanOrEqual(2)
      expect(new Set(active.map((job) => job.window.id)).size).toBe(active.length)
    }
  })

  it('does not resume cancelled work on subsequent timer ticks', () => {
    const run = tickDemoRun(createDemoRun(preparedDraft(), 'message', 'Test', 'Reply', 2))
    const stopped = stopDemoRun(run)
    expect(stopped.state).toBe('cancelled')
    expect(stopped.jobs.every((job) => job.phase === 'cancelled')).toBe(true)
    expect(tickDemoRun(stopped)).toBe(stopped)
  })
})
