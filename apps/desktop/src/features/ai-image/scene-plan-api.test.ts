import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callPlugin } from '@/lib/platform/native-plugins'
import { createScenePlan, generate, getScenePlan, type GenerateInput } from './api'
import { plannedGeneration, sceneDraft, SCENE_PLAN_UPDATE_HINT } from './scene-plan'
import { makePlan, makeSceneRecord, planContext } from './scene-plan.test-data'
import type { GenerationSource } from './types'

vi.mock('@/lib/platform/native-plugins', () => ({ callPlugin: vi.fn() }))

function request(): GenerateInput {
  const draft = sceneDraft(makePlan(), planContext)
  draft.prompt = 'Edited shared scene.'
  return {
    providerId: 'image-provider',
    imageModel: 'image-model',
    presetId: null,
    prompt: planContext.requirements,
    size: 'auto',
    inputFileIds: ['other-reference', 'reference'],
    ...plannedGeneration(draft, planContext, ['other-reference', 'reference']),
  }
}

beforeEach(() => {
  vi.mocked(callPlugin).mockReset()
})

describe('scene plan RPC', () => {
  it('creates the exact selected plan and reads its persisted ID', async () => {
    const { providerId, model, inputFileId, requirements, count } = planContext
    const input = { providerId, model, inputFileId, requirements, count }
    const plan = makePlan()
    vi.mocked(callPlugin).mockResolvedValue({ plan })
    expect(await createScenePlan(input)).toEqual(plan)
    expect(callPlugin).toHaveBeenNthCalledWith(
      1,
      'studio.ai-image',
      'image.provider',
      'image.plans.create',
      input,
      30000,
    )
    expect(await getScenePlan(plan.id)).toEqual(plan)
    expect(callPlugin).toHaveBeenNthCalledWith(
      2,
      'studio.ai-image',
      'image.provider',
      'image.plans.get',
      { id: plan.id },
      30000,
    )
    expect(callPlugin).toHaveBeenCalledTimes(2)
  })

  it.each(['image.plans.create', 'image.plans.get'])(
    'shows the old-plugin upgrade hint for missing %s without falling back',
    async (method) => {
      vi.mocked(callPlugin).mockRejectedValue('METHOD_NOT_FOUND')
      await expect(
        method === 'image.plans.create'
          ? createScenePlan(planContext)
          : getScenePlan('scene-plan'),
      ).rejects.toThrow(SCENE_PLAN_UPDATE_HINT)
      expect(callPlugin).toHaveBeenCalledTimes(1)
      expect(vi.mocked(callPlugin).mock.calls[0]?.[2]).toBe(method)
    },
  )

  it('rejects invalid paid input before invoking the plugin', async () => {
    await expect(createScenePlan({ ...planContext, count: 0 })).rejects.toThrow('1–4')
    await expect(createScenePlan({ ...planContext, inputFileId: '' })).rejects.toThrow(
      '参考图',
    )
    expect(callPlugin).not.toHaveBeenCalled()
  })

  it('does not accept an incomplete or wrong-count plan response', async () => {
    vi.mocked(callPlugin)
      .mockResolvedValueOnce({ plan: makePlan({ count: 2 }) })
      .mockResolvedValueOnce({})
    await expect(createScenePlan(planContext)).rejects.toThrow('数量')
    await expect(getScenePlan('scene-plan')).rejects.toThrow('无效')
    expect(callPlugin).toHaveBeenCalledTimes(2)
  })
})

describe('planned generation', () => {
  it('submits original constraints, edited views and explicit free preset without another vision call', async () => {
    const input = request()
    vi.mocked(callPlugin).mockResolvedValue({ record: makeSceneRecord() })
    await generate(input)
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.ai-image',
      'image.provider',
      'image.generate',
      input,
      30000,
    )
    expect(input.presetId).toBeNull()
    expect(input.prompt).toBe(planContext.requirements)
    expect(input.mode).toBe('edit')
    expect(input.count).toBe(3)
    expect(input.scenePlan?.prompt).toBe('Edited shared scene.')
    expect(input).not.toHaveProperty('visionProviderId')
    expect(input).not.toHaveProperty('visionFileId')
  })

  it('accepts a free smart plan with no additional user requirements', async () => {
    const input = { ...request(), prompt: '' }
    vi.mocked(callPlugin).mockResolvedValue({ record: makeSceneRecord() })
    await generate(input)
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.ai-image',
      'image.provider',
      'image.generate',
      input,
      30000,
    )
  })

  it('preserves Vinted source through its read-only compatibility check', async () => {
    const source: GenerationSource = {
      pluginId: 'studio.vinted-monitor',
      itemId: 'vinted.fr:123',
      title: 'Used wall art',
      url: 'https://www.vinted.fr/items/123',
    }
    const sourceFilter = { sourcePluginId: source.pluginId, sourceItemId: source.itemId }
    vi.mocked(callPlugin)
      .mockResolvedValueOnce({
        items: [],
        total: 0,
        page: 0,
        pageSize: 1,
        storageDurable: true,
        sourceFilter,
      })
      .mockResolvedValueOnce({ record: { ...makeSceneRecord(), source } })
    const input = { ...request(), source }
    await generate(input)
    expect(vi.mocked(callPlugin).mock.calls.map((call) => call[2])).toEqual([
      'image.records.list',
      'image.generate',
    ])
    expect(vi.mocked(callPlugin).mock.calls[1]?.[3]).toEqual(input)
  })

  it.each([
    { visionProviderId: 'vision-provider' },
    { visionProviderId: null },
    { visionModel: 'vision-model' },
    { visionFileId: 'reference' },
    { visionFileId: null },
    { count: 2 },
    { mode: 'generate' as const },
    { inputFileIds: [] },
  ])('blocks conflicting plan input before a paid call: %o', async (change) => {
    await expect(generate({ ...request(), ...change })).rejects.toThrow(
      '不能同时发起重复识图',
    )
    expect(callPlugin).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { scenePlan: { plan: { id: 'another-plan' }, views: [] } },
    { scenePlan: { plan: { id: 'scene-plan' }, views: [{ id: 'different-view' }] } },
    { scenePlan: {} },
  ])(
    'warns after a submitted task loses its plan acknowledgment without submitting twice',
    async (record) => {
      vi.mocked(callPlugin).mockResolvedValue({ record: { id: 'record', ...record } })
      await expect(generate(request())).rejects.toThrow('勿重复提交')
      expect(callPlugin).toHaveBeenCalledTimes(1)
    },
  )

  it('retains real generation errors without stripping the scene plan and retrying', async () => {
    vi.mocked(callPlugin).mockRejectedValue('Reference file missing')
    await expect(generate(request())).rejects.toThrow('Reference file missing')
    expect(callPlugin).toHaveBeenCalledTimes(1)
    expect(vi.mocked(callPlugin).mock.calls[0]?.[3]).toEqual(request())
  })
})
