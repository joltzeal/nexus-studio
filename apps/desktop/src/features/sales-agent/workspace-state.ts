import {
  AgentSavedPlanSchema,
  type AgentSavedPlan,
  type AgentWorkspaceEntry,
  type AgentWorkspaceSave,
} from '@nexus/plugin-sdk/agent'
import type { Product } from '@nexus/plugin-products/contracts'
import type { AgentDraft } from './assignment'

export function planFromDraft(draft: AgentDraft): AgentSavedPlan {
  return AgentSavedPlanSchema.parse({
    preset: draft.preset,
    instruction: draft.instruction,
    concurrency: draft.concurrency,
    productIds: draft.products.map((product) => product.id),
    windowIds: draft.windowIds,
    assignments: draft.windowIds.map((windowId) => {
      const productIds = draft.products
        .filter((product) => draft.assignments[product.id] === windowId)
        .map((product) => product.id)
      return {
        windowId,
        productIds,
        overrides: productIds.flatMap((id) =>
          draft.overrides[id] ? [draft.overrides[id]] : [],
        ),
        messages: draft.messages[windowId] ? [draft.messages[windowId]] : [],
      }
    }),
    unassignedOverrides: draft.products.flatMap((product) =>
      !draft.assignments[product.id] && draft.overrides[product.id]
        ? [draft.overrides[product.id]]
        : [],
    ),
  })
}

export function draftFromPlan(data: AgentSavedPlan, fresh: Product[]): AgentDraft {
  const plan = AgentSavedPlanSchema.parse(data)
  const products = new Map(fresh.map((product) => [product.id, product]))
  if (plan.productIds.some((id) => !products.has(id)))
    throw new Error('部分商品已不可见，未载入不完整草稿；请先在商品库核对。')
  if (plan.assignments.some((assignment) => assignment.messages.length > 1))
    throw new Error('此模板含单窗口多条消息，当前表单无法完整载入，请核对模板。')
  return {
    preset: plan.preset,
    instruction: plan.instruction,
    concurrency: plan.concurrency,
    products: plan.productIds.map((id) => products.get(id)!),
    windowIds: [...plan.windowIds],
    assignments: Object.fromEntries(
      plan.assignments.flatMap((assignment) =>
        assignment.productIds.map((id) => [id, assignment.windowId]),
      ),
    ),
    overrides: Object.fromEntries(
      [
        ...plan.assignments.flatMap((assignment) => assignment.overrides),
        ...plan.unassignedOverrides,
      ].map((override) => [override.productId, override]),
    ),
    messages: Object.fromEntries(
      plan.assignments.flatMap((assignment) =>
        assignment.messages[0] ? [[assignment.windowId, assignment.messages[0]]] : [],
      ),
    ),
  }
}

export function workspaceSaveOutcome(
  input: AgentWorkspaceSave,
  entry: AgentWorkspaceEntry,
): 'saved' | 'not_saved' | 'conflict' {
  if (entry.id !== input.id || entry.kind !== input.kind) return 'conflict'
  if (entry.revision === input.expectedRevision) return 'not_saved'
  return entry.revision === input.expectedRevision + 1 &&
    entry.name === input.name &&
    JSON.stringify(entry.data) === JSON.stringify(input.data)
    ? 'saved'
    : 'conflict'
}
