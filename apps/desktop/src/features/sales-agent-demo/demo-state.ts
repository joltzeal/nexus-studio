import {
  createDemoWindows,
  demoProducts,
  demoWindows,
  mugCompletion,
  type DemoProduct,
  type DemoWindow,
  type TaskKind,
} from './demo-data'

export interface DemoDraft {
  products: DemoProduct[]
  windows: DemoWindow[]
  windowIds: string[]
}

export function createDemoDraft(): DemoDraft {
  return {
    products: demoProducts.slice(0, 4).map((product) => ({ ...product })),
    windows: demoWindows.map((window) => ({ ...window, tags: [...window.tags] })),
    windowIds: demoWindows.slice(0, 3).map((window) => window.id),
  }
}

export function updateProduct(
  product: DemoProduct,
  patch: Partial<DemoProduct>,
): DemoProduct {
  return {
    ...product,
    ...patch,
    id: product.id,
    sampleIssue:
      product.sampleIssue === 'copy' &&
      (patch.title !== undefined || patch.description !== undefined)
        ? 'none'
        : product.sampleIssue,
    review: 'pending',
    reviewNote: '资料已修改，需重新检查',
  }
}

export function completeProducts(products: DemoProduct[]): DemoProduct[] {
  return products.map((product) => {
    if (product.id !== 'demo-product-03') return product
    const patch = Object.fromEntries(
      Object.entries(mugCompletion).filter(
        ([key]) => !product[key as keyof typeof mugCompletion].trim(),
      ),
    )
    if (!Object.keys(patch).length) return product
    return updateProduct(product, patch)
  })
}

export function missingFields(product: DemoProduct): string[] {
  const missing: string[] = []
  if (!product.title.trim()) missing.push('标题')
  if (!product.description.trim()) missing.push('描述')
  if (
    !product.price.trim() ||
    !Number.isFinite(Number(product.price)) ||
    Number(product.price) <= 0
  )
    missing.push('有效价格')
  if (!product.condition) missing.push('成色')
  return missing
}

export function reviewProducts(products: DemoProduct[]): DemoProduct[] {
  return products.map((product) => {
    const missing = missingFields(product)
    if (missing.length) {
      return { ...product, review: 'pending', reviewNote: `缺少${missing.join('、')}` }
    }
    if (product.sampleIssue === 'image') {
      return {
        ...product,
        review: 'skip',
        reviewNote: '模拟检查：画面过于光滑，跳过该商品',
      }
    }
    if (product.sampleIssue === 'copy') {
      const brand =
        product.brand && product.brand !== 'Unbranded' ? ` ${product.brand}` : ''
      const size = product.size ? `, size ${product.size}` : ''
      return {
        ...product,
        title: `Beige${brand} knit cardigan${size}`,
        description: `Soft beige cardigan${brand ? ` from${brand}` : ''}${size}. Worn a few times last winter. Light bobbling under the arms. All buttons are there. Listed as ${product.condition.toLowerCase()}. Happy to send measurements.`,
        sampleIssue: 'none',
        review: 'ready',
        reviewNote: '模拟检查：已将营销式文案改为自然英文',
      }
    }
    return { ...product, review: 'ready', reviewNote: '模拟图片与文案检查通过' }
  })
}

export function setSelectedWindows(draft: DemoDraft, windowIds: string[]): DemoDraft {
  const available = new Set(draft.windows.map((window) => window.id))
  const selected = [...new Set(windowIds)].filter((id) => available.has(id))
  return {
    ...draft,
    windowIds: selected,
    products: draft.products.map((product) =>
      product.windowId && !selected.includes(product.windowId)
        ? { ...product, windowId: null }
        : product,
    ),
  }
}

export function setDemoWindowCount(draft: DemoDraft, count: 4 | 100): DemoDraft {
  const windows = createDemoWindows(count)
  return setSelectedWindows(
    { ...draft, windows },
    windows.map((window) => window.id),
  )
}

export function assignProducts(
  draft: DemoDraft,
  productIds: string[],
  windowId: string | null,
): DemoDraft {
  if (
    windowId !== null &&
    (!draft.windowIds.includes(windowId) ||
      !draft.windows.some((window) => window.id === windowId))
  )
    return draft
  const selected = new Set(productIds)
  return {
    ...draft,
    products: draft.products.map((product) =>
      selected.has(product.id) && product.windowId !== windowId
        ? { ...product, windowId }
        : product,
    ),
  }
}

export function addProducts(draft: DemoDraft, productIds: string[]): DemoDraft {
  const existing = new Set(draft.products.map((product) => product.id))
  return {
    ...draft,
    products: [
      ...draft.products,
      ...demoProducts
        .filter((product) => productIds.includes(product.id) && !existing.has(product.id))
        .map((product) => ({ ...product, windowId: null })),
    ],
  }
}

export function planErrors(
  draft: DemoDraft,
  kind: TaskKind,
  name: string,
  instruction: string,
): string[] {
  const errors: string[] = []
  if (!name.trim()) errors.push('填写任务名称。')
  if (!instruction.trim()) errors.push('填写任务指令。')
  if (!draft.windowIds.length) errors.push('至少选择一个执行窗口。')
  if (kind !== 'listing') return errors
  if (!draft.products.length) errors.push('至少添加一件商品。')
  const unassigned = draft.products.filter(
    (product) => !product.windowId || !draft.windowIds.includes(product.windowId),
  )
  if (unassigned.length) errors.push(`${unassigned.length} 件商品尚未分配窗口。`)
  const incomplete = draft.products.filter((product) => missingFields(product).length)
  if (incomplete.length)
    errors.push(`${incomplete.length} 件商品资料未完整，请补全或编辑。`)
  const unreviewed = draft.products.filter((product) => product.review === 'pending')
  if (unreviewed.length) errors.push(`${unreviewed.length} 件商品尚未完成运行前检查。`)
  return errors
}

export type JobPhase =
  'queued' | 'checking' | 'executing' | 'completed' | 'blocked' | 'skipped' | 'cancelled'

export interface DemoJob {
  id: string
  window: DemoWindow
  product: DemoProduct | null
  phase: JobPhase
  detail: string
}

export interface DemoRun {
  name: string
  kind: TaskKind
  instruction: string
  concurrency: number
  state: 'running' | 'completed' | 'cancelled'
  jobs: DemoJob[]
  events: string[]
}

const finishedPhases = new Set<JobPhase>(['completed', 'blocked', 'skipped', 'cancelled'])

export function isJobFinished(job: DemoJob): boolean {
  return finishedPhases.has(job.phase)
}

export function createDemoRun(
  draft: DemoDraft,
  kind: TaskKind,
  name: string,
  instruction: string,
  concurrency: number,
): DemoRun {
  const jobs: DemoJob[] = draft.windows
    .filter((window) => draft.windowIds.includes(window.id))
    .flatMap((window) =>
      (kind === 'listing'
        ? draft.products.filter((product) => product.windowId === window.id)
        : [null]
      ).map((product, index) => ({
        id: `${window.id}-${index}`,
        window: { ...window, tags: [...window.tags] },
        product: product ? { ...product } : null,
        phase: 'queued' as const,
        detail: '等待该窗口的执行位置',
      })),
    )
  return {
    name,
    kind,
    instruction,
    concurrency: Math.max(1, Math.min(5, concurrency)),
    state: 'running',
    jobs,
    events: ['模拟批次已创建，准备按窗口执行。'],
  }
}

export function tickDemoRun(run: DemoRun): DemoRun {
  if (run.state !== 'running') return run
  const events = [...run.events]
  const jobs = run.jobs.map((job): DemoJob => {
    if (job.phase === 'checking') {
      if (job.window.status === 'blocked') {
        events.push(`${job.window.name}：检测到 blocked，停止该账号的任务。`)
        return { ...job, phase: 'blocked', detail: '账号被封禁，未执行任何写操作' }
      }
      if (job.product?.review === 'skip') {
        events.push(`${job.window.name}：跳过「${job.product.label}」，图片检查未通过。`)
        return { ...job, phase: 'skipped', detail: job.product.reviewNote }
      }
      return {
        ...job,
        phase: 'executing',
        detail:
          run.kind === 'listing'
            ? '模拟填写上架表单并核对商品资料'
            : run.kind === 'message'
              ? '模拟读取未读对话并准备回复'
              : '模拟整理账号标签、评价与余额',
      }
    }
    if (job.phase === 'executing') {
      events.push(`${job.window.name}：${job.product?.label ?? '账号任务'}模拟完成。`)
      return {
        ...job,
        phase: 'completed',
        detail:
          run.kind === 'listing'
            ? '模拟上架完成'
            : run.kind === 'message'
              ? '模拟回复完成'
              : '模拟检查完成；未写入真实账号池',
      }
    }
    return job
  })
  const blockedWindows = new Set(
    jobs.filter((job) => job.phase === 'blocked').map((job) => job.window.id),
  )
  for (const job of jobs) {
    if (job.phase === 'queued' && blockedWindows.has(job.window.id)) {
      job.phase = 'blocked'
      job.detail = '同一账号已被封禁，后续任务停止'
    }
  }
  const occupied = new Set(
    jobs
      .filter((job) => job.phase === 'checking' || job.phase === 'executing')
      .map((job) => job.window.id),
  )
  for (const job of jobs) {
    if (occupied.size >= run.concurrency) break
    if (job.phase !== 'queued' || occupied.has(job.window.id)) continue
    job.phase = 'checking'
    job.detail = '模拟核查登录态、账号状态与任务前置条件'
    occupied.add(job.window.id)
  }
  const done = jobs.every(isJobFinished)
  if (done) events.push('模拟批次已结束，结果按窗口保留。')
  return { ...run, jobs, events, state: done ? 'completed' : 'running' }
}

export function stopDemoRun(run: DemoRun): DemoRun {
  return {
    ...run,
    state: 'cancelled',
    jobs: run.jobs.map((job) =>
      isJobFinished(job) ? job : { ...job, phase: 'cancelled', detail: '已手动停止模拟' },
    ),
    events: [...run.events, '已停止模拟，完成的结果保留。'],
  }
}
