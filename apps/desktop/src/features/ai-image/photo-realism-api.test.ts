import { beforeEach, expect, it, vi } from 'vitest'
import { callPlugin } from '@/lib/platform/native-plugins'
import {
  createScenePlan,
  generate,
  testProviderImage,
  type GenerateInput,
  type ProviderImageTestInput,
} from './api'
import type { ScenePlanInput } from './scene-plan'
import { makePlan, makeSceneRecord, planContext } from './scene-plan.test-data'

vi.mock('@/lib/platform/native-plugins', () => ({ callPlugin: vi.fn() }))

const generation: GenerateInput = {
  providerId: 'image-provider',
  imageModel: 'image-model',
  mode: 'generate',
  presetId: null,
  prompt: 'An ordinary phone photo of a mug.',
  size: 'auto',
  count: 1,
  inputFileIds: [],
}
const testInput: ProviderImageTestInput = {
  id: 'image-provider',
  model: 'image-model',
  mode: 'generate',
  prompt: generation.prompt,
  size: 'auto',
  inputFileIds: [],
}
const operations = [
  {
    method: 'image.generate',
    run: (agingLevel: unknown) =>
      generate({ ...generation, agingLevel } as GenerateInput),
    result: (agingLevel?: string) => ({
      record: { ...makeSceneRecord(), ...(agingLevel ? { agingLevel } : {}) },
    }),
  },
  {
    method: 'image.providers.testImage',
    run: (agingLevel: unknown) =>
      testProviderImage({ ...testInput, agingLevel } as ProviderImageTestInput),
    result: (agingLevel?: string) => ({
      record: { ...makeSceneRecord(), ...(agingLevel ? { agingLevel } : {}) },
    }),
  },
  {
    method: 'image.plans.create',
    run: (agingLevel: unknown) =>
      createScenePlan({ ...planContext, agingLevel } as ScenePlanInput),
    result: (agingLevel?: string) => ({
      plan: { ...makePlan(), ...(agingLevel ? { agingLevel } : {}) },
    }),
  },
]
beforeEach(() => vi.mocked(callPlugin).mockReset())

it.each(operations)(
  'validates and preserves the explicit level for $method',
  async ({ run, result, method }) => {
    vi.mocked(callPlugin).mockResolvedValue(result('light'))
    const accepted = await run('light')
    expect('record' in accepted ? accepted.record.agingLevel : accepted.agingLevel).toBe(
      'light',
    )
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.ai-image',
      'image.provider',
      method,
      expect.objectContaining({ agingLevel: 'light' }),
      30000,
    )
  },
)

it.each(operations)(
  'blocks invalid levels before paid $method and never silently drops them',
  async ({ run }) => {
    for (const value of ['unknown', null, 3]) {
      await expect(run(value)).rejects.toThrow('做旧')
    }
    expect(callPlugin).not.toHaveBeenCalled()
  },
)

it.each(operations)(
  'reports an accepted $method with a lost level without resubmission',
  async ({ run, result }) => {
    vi.mocked(callPlugin).mockResolvedValue(result())
    await expect(run('heavy')).rejects.toThrow('勿重复')
    expect(callPlugin).toHaveBeenCalledOnce()
  },
)
