import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  MAX_SCENE_PROMPT,
  MAX_VIEW_LABEL,
  MAX_VIEW_PROMPT,
  SCENE_PLAN_METHODS,
  SCENE_PLAN_STALE_HINT,
  SCENE_PLAN_UPDATE_HINT,
  parseScenePlan,
  plannedGeneration,
  sceneContextKey,
  sceneDraft,
  sceneDraftProblem,
  scenePlanError,
  applySceneRecommendation,
  supportsScenePlans,
  visionProviderKey,
} from './scene-plan'
import { ScenePlanRecord } from './scene-plan-record'
import { selectedRecordMedia } from './selection'
import {
  makePlan,
  makeProvider,
  makeSceneRecord,
  planContext,
} from './scene-plan.test-data'
import { sceneProgress, statusText, type ScenePlan } from './types'

describe('scene plan contract and editable draft', () => {
  it.each(['running', 'success', 'failed'] as const)(
    'reads a persisted %s plan',
    (status) => {
      const plan = makePlan({
        status,
        ...(status === 'success' ? {} : { result: null }),
        error: status === 'failed' ? 'Model unavailable' : null,
      })
      expect(parseScenePlan(plan)).toEqual(plan)
    },
  )

  it.each([
    undefined,
    { status: 'unknown' },
    makePlan({ status: 'success', result: null }),
    makePlan({ count: 2 }),
    makePlan({ count: 1.5 }),
    { ...makePlan(), inputFileId: '' },
  ])('rejects incomplete or mismatched responses', (value) => {
    expect(() => parseScenePlan(value)).toThrow()
  })

  it.each(['id', 'label', 'prompt'] as const)(
    'rejects normalized duplicate view %s',
    (field) => {
      const plan = makePlan()
      if (!plan.result) throw new Error('Missing fixture result')
      const [first, second] = plan.result.views
      if (!first || !second) throw new Error('Missing fixture views')
      second[field] = `  ${first[field].toUpperCase()}  `
      expect(() => parseScenePlan(plan)).toThrow('重复视角')
    },
  )

  it('keeps original requirements and the recognition snapshot while editing shared and per-view prompts', () => {
    const plan = makePlan()
    const original = structuredClone(plan)
    const draft = sceneDraft(plan, planContext)
    draft.prompt = 'My revised shared scene.'
    const first = draft.views[0]
    if (!first) throw new Error('Missing fixture view')
    first.prompt = 'My revised front crop.'
    first.label = '我的正面图'
    expect(plan).toEqual(original)
    expect(sceneDraftProblem(draft, planContext)).toBeNull()
    const payload = plannedGeneration(draft, planContext, [
      'other-reference',
      'reference',
    ])
    expect(payload).toEqual({
      mode: 'edit',
      count: 3,
      scenePlan: { id: plan.id, prompt: draft.prompt, views: draft.views },
    })
    expect(payload.scenePlan.views).not.toBe(draft.views)
    expect(payload).not.toHaveProperty('visionProviderId')
    expect(payload).not.toHaveProperty('visionFileId')
    expect(plan.requirements).toBe(planContext.requirements)
  })

  it.each([
    { providerId: 'other-provider' },
    { model: 'another-vision-model' },
    { providerKey: 'new-vision-model' },
    { inputFileId: 'other-reference' },
    { requirements: 'Changed requirements' },
    { count: 4 },
  ])('blocks a stale draft without discarding edits: %o', (change) => {
    const draft = sceneDraft(makePlan(), planContext)
    draft.prompt = 'Keep these edits.'
    const context = { ...planContext, ...change }
    expect(sceneDraftProblem(draft, context)).toBe(SCENE_PLAN_STALE_HINT)
    expect(() =>
      plannedGeneration(draft, context, ['reference', 'other-reference']),
    ).toThrow(SCENE_PLAN_STALE_HINT)
    expect(draft.prompt).toBe('Keep these edits.')
  })

  it('does not accept a plan for another request or silently trim the original requirements', () => {
    expect(() => sceneDraft(makePlan({ model: 'changed-model' }), planContext)).toThrow(
      '不一致',
    )
    expect(() => sceneDraft(makePlan({ inputFileId: 'other' }), planContext)).toThrow(
      '不一致',
    )
    expect(() =>
      sceneDraft(
        makePlan({ requirements: planContext.requirements.trim() }),
        planContext,
      ),
    ).toThrow('不一致')
    expect(() =>
      plannedGeneration(sceneDraft(makePlan(), planContext), planContext, ['other']),
    ).toThrow('参考图已移除')
  })

  it('keeps legacy plans readable without inventing titles or descriptions', () => {
    const plan = makePlan()
    if (!plan.result) throw new Error('Missing fixture result')
    delete plan.result.title
    delete plan.result.description
    expect(parseScenePlan(plan).result).not.toHaveProperty('title')
    expect(parseScenePlan(plan).result).not.toHaveProperty('description')
  })

  it('keeps a plan current when a provider sheet refreshes metadata or non-vision models', () => {
    const provider = makeProvider()
    const before = { ...planContext, providerKey: visionProviderKey(provider) }
    const draft = sceneDraft(makePlan(), before)
    draft.prompt = 'An edited scene retained across configuration.'
    const refreshed = makeProvider({
      name: 'Renamed provider',
      imageModel: 'new-image-model',
      updatedAt: '2026-10-25T02:00:00.000Z',
    })
    const after = { ...before, providerKey: visionProviderKey(refreshed) }
    expect(sceneContextKey(after)).toBe(sceneContextKey(before))
    expect(sceneDraftProblem(draft, after)).toBeNull()
    expect(draft.prompt).toBe('An edited scene retained across configuration.')
  })

  it.each([
    { visionModel: 'other-model' },
    { baseUrl: 'https://other.example.invalid/v1' },
    { hasApiKey: false },
    { id: 'other-provider' },
  ])('invalidates the plan when vision configuration changes: %o', (change) => {
    const before = { ...planContext, providerKey: visionProviderKey(makeProvider()) }
    const draft = sceneDraft(makePlan(), before)
    const after = { ...before, providerKey: visionProviderKey(makeProvider(change)) }
    expect(sceneDraftProblem(draft, after)).toBe(SCENE_PLAN_STALE_HINT)
  })

  it('automatically recommends once per plan and preserves an explicit free prompt choice on later renders and edits', () => {
    const draft = sceneDraft(makePlan(), planContext)
    const initial = { id: 'table-scene', revision: 0 }
    expect(applySceneRecommendation(initial, draft).id).toBe('wall-hang')
    const free = { id: null, revision: 1 }
    expect(applySceneRecommendation(free, draft).id).toBeNull()
    expect(
      applySceneRecommendation(free, { ...draft, prompt: 'Edited shared prompt.' }).id,
    ).toBeNull()
    expect(applySceneRecommendation(free, structuredClone(draft)).id).toBeNull()
    const newDraft = sceneDraft(makePlan({ id: 'new-plan' }), planContext, free.revision)
    expect(applySceneRecommendation(free, newDraft).id).toBe('wall-hang')
  })

  it('preserves a free choice made in manual mode when reusing the same completed plan', () => {
    const draft = sceneDraft(makePlan(), planContext, 2)
    const before = { id: 'table-scene', revision: 2 }
    const completedChoice = applySceneRecommendation(before, draft)
    expect(completedChoice.id).toBe('wall-hang')
    const manualChoice = { id: null, revision: before.revision + 1 }
    expect(applySceneRecommendation(manualChoice, draft)).toBe(manualChoice)
    expect(
      applySceneRecommendation(manualChoice, { ...draft, prompt: 'More edits.' }).id,
    ).toBeNull()
  })

  it.each([null, 'another-preset'])(
    'preserves a newer explicit choice while a plan is pending or its read is retried: %s',
    (id) => {
      const revisionAtStart = 4
      const choice = { id, revision: revisionAtStart + 1 }
      const returnedDraft = sceneDraft(makePlan(), planContext, revisionAtStart)
      expect(applySceneRecommendation(choice, returnedDraft).id).toBe(id)
      const retriedReadDraft = sceneDraft(makePlan(), planContext, revisionAtStart)
      expect(applySceneRecommendation(choice, retriedReadDraft).id).toBe(id)
    },
  )

  it('accepts empty user requirements with a valid shared scene and free preset', () => {
    const context = { ...planContext, requirements: '' }
    const draft = sceneDraft(makePlan({ requirements: '' }), context)
    expect(sceneDraftProblem(draft, context)).toBeNull()
    expect(applySceneRecommendation({ id: null, revision: 1 }, draft).id).toBeNull()
    expect(plannedGeneration(draft, context, ['reference']).scenePlan.prompt).toBe(
      draft.prompt,
    )
  })

  it('enforces prompt lengths, distinct views, and original view order without truncating edits', () => {
    const draft = sceneDraft(makePlan(), planContext)
    draft.prompt = 'x'.repeat(MAX_SCENE_PROMPT + 1)
    expect(sceneDraftProblem(draft, planContext)).toContain('共享场景')
    expect(draft.prompt.length).toBe(MAX_SCENE_PROMPT + 1)
    draft.prompt = 'x'.repeat(MAX_SCENE_PROMPT)
    const [first, second] = draft.views
    if (!first || !second) throw new Error('Missing fixture views')
    first.label = 'x'.repeat(MAX_VIEW_LABEL + 1)
    expect(sceneDraftProblem(draft, planContext)).toContain('名称')
    first.label = 'x'.repeat(MAX_VIEW_LABEL)
    first.prompt = 'x'.repeat(MAX_VIEW_PROMPT + 1)
    expect(sceneDraftProblem(draft, planContext)).toContain('提示词')
    first.prompt = 'x'.repeat(MAX_VIEW_PROMPT)
    expect(sceneDraftProblem(draft, planContext)).toBeNull()
    first.prompt = 'Visible   face'
    second.prompt = '  ＶＩＳＩＢＬＥ \n face '
    expect(sceneDraftProblem(draft, planContext)).toContain('互不相同')
    second.prompt = 'Different view.'
    draft.views.reverse()
    expect(sceneDraftProblem(draft, planContext)).toContain('顺序')
  })
})

describe('legacy plugin compatibility', () => {
  it('requires both plan methods before enabling smart mode', () => {
    expect(supportsScenePlans(undefined)).toBe(false)
    expect(supportsScenePlans(['image.generate'])).toBe(false)
    expect(supportsScenePlans(['image.plans.create'])).toBe(false)
    expect(supportsScenePlans(['image.plans.get'])).toBe(false)
    expect(supportsScenePlans(['image.generate', ...SCENE_PLAN_METHODS])).toBe(true)
  })

  it.each(['插件未声明该方法', 'METHOD_NOT_FOUND', 'Unknown method image.plans.create'])(
    'offers an update hint for %s',
    (error) => {
      expect(scenePlanError(error).message).toBe(SCENE_PLAN_UPDATE_HINT)
      expect(scenePlanError(new Error('Connection refused')).message).toBe(
        'Connection refused',
      )
    },
  )
})

describe('partial multi-view records', () => {
  it('maps selected outputs and references by file ID across failed views and out-of-order outputs', () => {
    const record = makeSceneRecord()
    const failed = selectedRecordMedia(record, 0, 'front')
    expect(failed.output).toBeNull()
    expect(failed.outputIndex).toBe(-1)
    expect(failed.selectedView?.error).toContain('front view')
    const room = selectedRecordMedia(record, 0, 'room')
    expect(room.output?.id).toBe('room-output')
    expect(room.outputIndex).toBe(1)
    expect(room.reference?.id).toBe('reference')
    const detail = selectedRecordMedia(record, 1, 'detail')
    expect(detail.output?.id).toBe('detail-output')
    expect(detail.outputIndex).toBe(0)
  })

  it('reports retained progress and preserves legacy status and media selection', () => {
    const record = makeSceneRecord()
    expect(sceneProgress(record)).toEqual({ completed: 2, total: 3 })
    expect(statusText(record)).toBe('部分完成 · 2/3')
    expect(statusText({ ...record, status: 'running' })).toBe('正在生成视角 · 2/3')
    const legacy = { ...record }
    delete legacy.scenePlan
    expect(sceneProgress(legacy)).toBeNull()
    expect(statusText({ ...legacy, status: 'success' })).toBe('已生成')
    expect(selectedRecordMedia(legacy, 1, '').output?.id).toBe('room-output')
    expect(selectedRecordMedia(legacy, 1, '').reference?.id).toBe('other-reference')
  })

  it('renders recognition, uncertainty, edited prompts and individual failure evidence', () => {
    const scene = makeSceneRecord().scenePlan
    if (!scene) throw new Error('Missing fixture scene')
    const html = renderToStaticMarkup(createElement(ScenePlanRecord, { scene }))
    for (const text of [
      '墙面装饰画',
      '仅凭照片无法确认材质和背面',
      'Edited shared scene.',
      '正面',
      '环境',
      '细节',
      '已完成',
      'Upstream rejected the front view.',
      '实际生成提示词',
      'Close crop of the evidenced worn corner.',
    ]) {
      expect(html).toContain(text)
    }
  })

  it('does not accept a successful plan with a missing required runtime field', () => {
    const plan: Partial<ScenePlan> = makePlan()
    delete plan.providerId
    expect(() => parseScenePlan(plan)).toThrow()
  })
})
