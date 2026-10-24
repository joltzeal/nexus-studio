import { MAX_PROMPT_CHARACTERS } from './selection'
import {
  message,
  type Provider,
  type ScenePlan,
  type ScenePlanResult,
  type SceneView,
} from './types'

export const SCENE_PLAN_UPDATE_HINT = '请更新 AI 生图插件后使用智能识图与场景推荐。'
export const SCENE_PLAN_STALE_HINT = '参考图、识图模型、要求或张数已变化，请重新识图。'
export const SCENE_PLAN_METHODS = ['image.plans.create', 'image.plans.get'] as const
export const MAX_SCENE_PROMPT = 6000
export const MAX_VIEW_PROMPT = 4000
export const MAX_VIEW_LABEL = 120

export interface ScenePlanInput {
  providerId: string
  inputFileId: string
  requirements: string
  count: number
}

export interface ScenePlanContext extends ScenePlanInput {
  providerKey: string
}

export interface ScenePlanDraft {
  plan: ScenePlan
  contextKey: string
  presetRevision: number
  prompt: string
  views: SceneView[]
}

export interface ScenePresetChoice {
  id: string | null
  revision: number
}

export function applySceneRecommendation(
  choice: ScenePresetChoice,
  draft: ScenePlanDraft,
): ScenePresetChoice {
  // Only the choice that existed when planning began may be auto-replaced.
  if (choice.revision === draft.presetRevision && draft.plan.result) {
    return { ...choice, id: draft.plan.result.presetId }
  }
  return choice
}

export function supportsScenePlans(methods: readonly string[] | undefined): boolean {
  return (
    methods !== undefined &&
    SCENE_PLAN_METHODS.every((method) => methods.includes(method))
  )
}

export function scenePlanError(cause: unknown): Error {
  const text = message(cause)
  return new Error(
    /未声明该方法|不支持该方法|method.not.found|unknown method|unsupported method/i.test(
      text,
    )
      ? SCENE_PLAN_UPDATE_HINT
      : text,
  )
}

export function visionProviderKey(provider: Provider | undefined): string {
  return provider
    ? JSON.stringify([
        provider.id,
        provider.kind,
        provider.baseUrl,
        provider.visionModel,
        provider.hasApiKey,
      ])
    : ''
}

export function sceneContextKey(context: ScenePlanContext): string {
  return JSON.stringify([
    context.providerId,
    context.providerKey,
    context.inputFileId,
    context.requirements,
    context.count,
  ])
}

export function validateScenePlanInput(input: ScenePlanInput): void {
  if (!input.providerId || !input.inputFileId)
    throw new Error('请选择识图模型和一张已上传的参考图。')
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 4)
    throw new Error('请选择 1–4 个视角。')
  if (input.requirements.length > MAX_PROMPT_CHARACTERS)
    throw new Error('请精简附加要求后再识图，原文已保留。')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('插件返回的场景方案无效，请更新插件后重试。')
  return value as Record<string, unknown>
}

function text(value: unknown, required = false): string {
  if (typeof value !== 'string' || (required && !value.trim()))
    throw new Error('场景方案缺少必要文字，请重新识图。')
  return value
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value)
}

function distinctViews(views: SceneView[]): boolean {
  const normalize = (value: string) =>
    value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
  return (['id', 'label', 'prompt'] as const).every(
    (field) => new Set(views.map((view) => normalize(view[field]))).size === views.length,
  )
}

export function parseScenePlan(value: unknown): ScenePlan {
  const plan = object(value)
  if (
    typeof plan.status !== 'string' ||
    !['running', 'success', 'failed'].includes(plan.status) ||
    typeof plan.providerKind !== 'string' ||
    !['openai', 'openai_compatible'].includes(plan.providerKind) ||
    typeof plan.count !== 'number' ||
    !Number.isInteger(plan.count) ||
    plan.count < 1 ||
    plan.count > 4
  ) {
    throw new Error('插件返回的场景方案状态或视角数量无效，请更新插件后重试。')
  }
  let result: ScenePlanResult | null = null
  if (plan.result !== null) {
    const raw = object(plan.result)
    if (!Array.isArray(raw.views) || raw.views.length !== plan.count)
      throw new Error('方案视角数量与请求不一致，请重新识图。')
    const views = raw.views.map((entry) => {
      const view = object(entry)
      return {
        id: text(view.id, true),
        label: text(view.label, true),
        prompt: text(view.prompt, true),
      }
    })
    if (!distinctViews(views)) throw new Error('方案包含重复视角，请重新识图。')
    result = {
      product: text(raw.product),
      material: text(raw.material),
      observations: text(raw.observations),
      uncertainties: text(raw.uncertainties),
      presetId: text(raw.presetId, true),
      reason: text(raw.reason),
      prompt: text(raw.prompt, true),
      views,
    }
  }
  if (plan.status === 'success' && result === null)
    throw new Error('识图已结束，但插件未返回可用方案。')
  return {
    id: text(plan.id, true),
    createdAt: text(plan.createdAt, true),
    updatedAt: text(plan.updatedAt, true),
    status: plan.status as ScenePlan['status'],
    providerId: text(plan.providerId, true),
    providerName: text(plan.providerName),
    providerKind: plan.providerKind as ScenePlan['providerKind'],
    model: text(plan.model, true),
    inputFileId: text(plan.inputFileId, true),
    requirements: text(plan.requirements),
    count: plan.count,
    result,
    error: nullableText(plan.error),
  }
}

export function sceneDraft(
  plan: ScenePlan,
  context: ScenePlanContext,
  presetRevision = 0,
): ScenePlanDraft {
  validateScenePlanInput(context)
  if (plan.status !== 'success' || !plan.result) throw new Error('场景方案尚未完成。')
  if (
    plan.providerId !== context.providerId ||
    plan.inputFileId !== context.inputFileId ||
    plan.count !== context.count ||
    plan.requirements !== context.requirements ||
    plan.result.views.length !== context.count
  ) {
    throw new Error('返回的方案与当前参考图、模型、要求或张数不一致，请重新识图。')
  }
  return {
    plan,
    contextKey: sceneContextKey(context),
    presetRevision,
    prompt: plan.result.prompt,
    views: plan.result.views.map((view) => ({ ...view })),
  }
}

export function sceneDraftProblem(
  draft: ScenePlanDraft | null,
  context: ScenePlanContext,
): string | null {
  if (!draft) return '请先点击智能识图，完成场景方案后再生成。'
  if (draft.contextKey !== sceneContextKey(context)) return SCENE_PLAN_STALE_HINT
  if (draft.plan.status !== 'success' || !draft.plan.result) return '场景方案尚未完成。'
  if (draft.views.length !== context.count || draft.views.length !== draft.plan.count)
    return '视角数量不一致，请重新识图。'
  if (!draft.prompt.trim() || draft.prompt.length > MAX_SCENE_PROMPT)
    return `共享场景提示词需为 1–${String(MAX_SCENE_PROMPT)} 字符。`
  const original = draft.plan.result.views
  if (
    draft.views.some(
      (view, index) =>
        view.id !== original[index]?.id ||
        !view.label.trim() ||
        view.label.length > MAX_VIEW_LABEL ||
        !view.prompt.trim() ||
        view.prompt.length > MAX_VIEW_PROMPT,
    )
  ) {
    return `请保留原视角顺序；每个视角需填写名称（最多 ${MAX_VIEW_LABEL} 字符）和提示词（最多 ${MAX_VIEW_PROMPT} 字符）。`
  }
  if (!distinctViews(draft.views)) {
    return '各视角的名称与提示词需互不相同，请保留视角差异。'
  }
  return null
}

export function plannedGeneration(
  draft: ScenePlanDraft,
  context: ScenePlanContext,
  inputFileIds: string[],
) {
  const problem = sceneDraftProblem(draft, context)
  if (problem) throw new Error(problem)
  if (!inputFileIds.includes(draft.plan.inputFileId))
    throw new Error('方案使用的参考图已移除，请重新识图。')
  return {
    mode: 'edit' as const,
    count: draft.views.length,
    scenePlan: {
      id: draft.plan.id,
      prompt: draft.prompt,
      views: draft.views.map((view) => ({ ...view })),
    },
  }
}
