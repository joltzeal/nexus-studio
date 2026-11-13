import {
  AgentBatchCreateSchema,
  AgentProductOverrideSchema,
  type AgentBatchCreate,
  type AgentPreset,
  type AgentProductOverride,
} from '@nexus/plugin-sdk/agent'
import type { Product } from '@nexus/plugin-products/contracts'
import type { AgentTarget } from './api'

export interface MessageDraft {
  conversationId: string
  text: string
}

export type ProductEditKey =
  | 'title'
  | 'description'
  | 'price'
  | 'currency'
  | 'condition'
  | 'brand'
  | 'size'
  | 'category'
export type ProductEditValues = Record<ProductEditKey, string>

export function parseProductEdits(
  id: string,
  values: Partial<ProductEditValues>,
): AgentProductOverride {
  const parsed = AgentProductOverrideSchema.safeParse({
    productId: id,
    ...values,
    ...(values.price === undefined
      ? {}
      : { price: values.price.trim() === '' ? NaN : Number(values.price) }),
  })
  if (!parsed.success)
    throw new Error('请填写有效标题、描述、正数价格与币种；选填字段可留空。')
  return parsed.data
}

export interface AgentDraft {
  preset: AgentPreset
  instruction: string
  concurrency: number
  products: Product[]
  windowIds: string[]
  assignments: Record<string, string>
  overrides: Record<string, AgentProductOverride>
  messages: Record<string, MessageDraft>
}

export function emptyAgentDraft(): AgentDraft {
  return {
    preset: 'post_listing',
    instruction: '',
    concurrency: 3,
    products: [],
    windowIds: [],
    assignments: {},
    overrides: {},
    messages: {},
  }
}

export function addDraftProducts(
  draft: AgentDraft,
  products: readonly Product[],
): AgentDraft {
  const byId = new Map(draft.products.map((product) => [product.id, product]))
  for (const product of products) {
    // Picking a product again must retain the user's batch edits and current revision.
    if (!byId.has(product.id)) byId.set(product.id, product)
  }
  if (byId.size > 100) throw new Error('每个批次最多选择 100 件商品。')
  return { ...draft, products: [...byId.values()] }
}

export function setDraftWindows(draft: AgentDraft, ids: readonly string[]): AgentDraft {
  const windowIds = [...new Set(ids)]
  if (windowIds.length > 100) throw new Error('每个批次最多选择 100 个窗口。')
  const selected = new Set(windowIds)
  return {
    ...draft,
    windowIds,
    assignments: Object.fromEntries(
      Object.entries(draft.assignments).filter(([, windowId]) => selected.has(windowId)),
    ),
    messages: Object.fromEntries(
      Object.entries(draft.messages).filter(([windowId]) => selected.has(windowId)),
    ),
  }
}

export function assignDraftProducts(
  draft: AgentDraft,
  productIds: readonly string[],
  windowId: string | null,
): AgentDraft {
  if (windowId !== null && !draft.windowIds.includes(windowId))
    throw new Error('请先选择目标执行窗口。')
  const products = new Set(draft.products.map((product) => product.id))
  const assignments = { ...draft.assignments }
  for (const id of productIds) {
    if (!products.has(id)) throw new Error('拖放的商品不属于当前批次，请重新选择。')
    if (windowId === null) delete assignments[id]
    else assignments[id] = windowId
  }
  return { ...draft, assignments }
}

export function removeDraftProduct(draft: AgentDraft, id: string): AgentDraft {
  const assignments = { ...draft.assignments }
  const overrides = { ...draft.overrides }
  delete assignments[id]
  delete overrides[id]
  return {
    ...draft,
    products: draft.products.filter((product) => product.id !== id),
    assignments,
    overrides,
  }
}

export function effectiveProduct(draft: AgentDraft, product: Product): Product {
  const override = draft.overrides[product.id]
  return {
    ...product,
    title: override?.title ?? product.title,
    description: override?.description ?? product.description,
    price: override?.price ?? product.price,
    currency: override?.currency ?? product.currency,
    condition: override?.condition ?? product.condition,
    brand: override?.brand ?? product.brand,
    size: override?.size ?? product.size,
    category: override?.category ?? product.category,
  }
}

export function englishText(value: string): boolean {
  if (!/[A-Za-z]/.test(value)) return false
  return [...value].every(
    (character) => !/\p{L}/u.test(character) || /\p{Script=Latin}/u.test(character),
  )
}

export function listingProblems(draft: AgentDraft, product: Product): string[] {
  const current = effectiveProduct(draft, product)
  const issues: string[] = []
  if (product.publicationCount > 0) issues.push('已有发布记录，禁止重复上架')
  if (product.status === 'archived') issues.push('商品已归档')
  if (!product.images.length) issues.push('缺少图片')
  if (!current.title.trim()) issues.push('缺少标题')
  if (!current.description.trim()) issues.push('缺少描述')
  if (current.price === null || !Number.isFinite(current.price) || current.price <= 0)
    issues.push('价格无效')
  if (!current.condition.trim()) issues.push('缺少成色')
  return issues
}

export function draftProblems(
  draft: AgentDraft,
  targets: readonly AgentTarget[],
): string[] {
  const issues: string[] = []
  if (!draft.windowIds.length) issues.push('请选择执行窗口。')
  const byId = new Map(targets.map((target) => [target.id, target]))
  for (const id of draft.windowIds) {
    const target = byId.get(id)
    if (!target) issues.push(`窗口 ${id} 不在当前列表中，请刷新核对。`)
    else if (target.unavailable) issues.push(`${target.name}：${target.unavailable}`)
    if (
      draft.preset === 'post_listing' &&
      !draft.products.some((product) => draft.assignments[product.id] === id)
    )
      issues.push(`${target?.name ?? id}：请分配商品，或取消选择此窗口。`)
    if (draft.preset === 'message') {
      const message = draft.messages[id]
      if (!message || !/^\d{1,32}$/.test(message.conversationId))
        issues.push(`${target?.name ?? id}：请明确填写 conversationId（1–32 位数字）。`)
      if (
        !message ||
        !englishText(message.text.trim()) ||
        message.text.trim().length > 4000
      )
        issues.push(`${target?.name ?? id}：请填写英文消息（最多 4000 字符）。`)
    }
  }
  if (draft.preset === 'post_listing') {
    if (!draft.products.length) issues.push('请从商品库选择商品。')
    for (const product of draft.products) {
      if (!draft.assignments[product.id]) issues.push(`${product.name}：未分配窗口。`)
      for (const problem of listingProblems(draft, product))
        issues.push(`${product.name}：${problem}。`)
    }
  }
  if (
    !Number.isInteger(draft.concurrency) ||
    draft.concurrency < 1 ||
    draft.concurrency > 10
  )
    issues.push('同时执行窗口数必须为 1–10。')
  if (draft.instruction.trim().length > 4000) issues.push('任务指令最多 4000 字符。')
  return issues
}

export function batchInput(
  draft: AgentDraft,
  targets: readonly AgentTarget[],
  operationId: string,
): AgentBatchCreate {
  const issues = draftProblems(draft, targets)
  if (issues.length) throw new Error(issues[0])
  return AgentBatchCreateSchema.parse({
    operationId,
    preset: draft.preset,
    instruction: draft.instruction,
    concurrency: draft.concurrency,
    assignments: draft.windowIds.map((windowId) => {
      const productIds =
        draft.preset === 'post_listing'
          ? draft.products
              .filter((product) => draft.assignments[product.id] === windowId)
              .map((product) => product.id)
          : []
      return {
        windowId,
        productIds,
        overrides: productIds.flatMap((id) =>
          draft.overrides[id] ? [draft.overrides[id]] : [],
        ),
        messages: draft.preset === 'message' ? [draft.messages[windowId]] : [],
      }
    }),
  })
}

/** Lost replies reuse the exact operation identity until the submitted form changes. */
export class BatchSubmission {
  private fingerprint: string | null = null
  private operationId: string | null = null
  private input: AgentBatchCreate | null = null

  original(): AgentBatchCreate {
    if (!this.input) throw new Error('没有可核对的原创建请求。')
    return structuredClone(this.input)
  }

  prepare(draft: AgentDraft, targets: readonly AgentTarget[]): AgentBatchCreate {
    const input = batchInput(draft, targets, this.operationId ?? crypto.randomUUID())
    const fingerprint = JSON.stringify([
      input.preset,
      input.instruction,
      input.concurrency,
      input.assignments,
    ])
    if (this.fingerprint !== null && this.fingerprint !== fingerprint)
      input.operationId = crypto.randomUUID()
    this.fingerprint = fingerprint
    this.operationId = input.operationId
    this.input = structuredClone(input)
    return input
  }
}
