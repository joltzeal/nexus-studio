import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AiImage, AI_IMAGE_METHODS } from './ai-image.js'
import type {
  GenerationRecord,
  ProviderView,
  ScenePlan,
  ScenePlanResult,
} from '../domain/types.js'
import { requestImages, requestScenePlan, requestVision } from '../services/openai.js'
import { createMemoryImageStore } from '../store/image-files.js'
import { createMemoryStore } from '../store/private-store.js'

vi.mock('../services/openai.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/openai.js')>()),
  requestImages: vi.fn(),
  requestScenePlan: vi.fn(),
  requestVision: vi.fn(),
}))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const PROVIDER = {
  name: 'Gateway',
  kind: 'openai_compatible',
  baseUrl: 'https://gateway.example/v1',
  apiKey: 'synthetic-test-key',
  imageModel: 'exact-image-model',
  visionModel: 'exact-vision-model',
}
const GENERATE = {
  imageModel: 'exact-image-model',
  mode: 'generate',
  presetId: null,
  prompt: 'A used cup on a table.',
  size: 'auto',
  count: 1,
  inputFileIds: [],
}
const VISION = {
  title: 'Used cup',
  description: 'A chipped ceramic cup.',
  prompt: 'Show the same cup and preserve its chipped rim.',
}
const PLAN: ScenePlanResult = {
  ...VISION,
  product: 'Cup',
  material: 'Appears ceramic',
  observations: 'Visible chipped rim.',
  uncertainties: 'Underside not visible.',
  presetId: 'wood-desk',
  reason: 'A table supports this object.',
  views: [
    { id: 'front', label: 'Front', prompt: 'Show the visible front.' },
    { id: 'detail', label: 'Detail', prompt: 'Show the evidenced chipped rim.' },
  ],
}

function setup() {
  const store = createMemoryStore()
  const images = createMemoryImageStore()
  const plugin = new AiImage({
    store,
    images,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    idFactory: randomUUID,
  })
  const call = <T>(method: string, payload: unknown = {}) =>
    plugin.call({
      requestId: randomUUID(),
      capability: 'image.provider',
      method,
      payload,
      deadlineAt: Date.now() + 5000,
      assertAlive: () => undefined,
    }) as Promise<T>
  const idle = async () => {
    await vi.waitFor(() => {
      expect(plugin.status()['running']).toBe(0)
      expect(plugin.status()['runningPlans']).toBe(0)
    })
    return store.read()
  }
  return { call, store, images, idle }
}

beforeEach(() => {
  vi.mocked(requestImages)
    .mockReset()
    .mockResolvedValue([{ bytes: PNG, mime: 'image/png', revisedPrompt: null }])
  vi.mocked(requestVision).mockReset().mockResolvedValue(VISION)
  vi.mocked(requestScenePlan).mockReset().mockResolvedValue(PLAN)
  // Any accidental escape from the three model boundaries must fail locally.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network')))
})
afterEach(() => vi.unstubAllGlobals())

describe('provider transport configuration', () => {
  it('returns defaults and a separate capability marker without adding methods', async () => {
    const { call, store } = setup()
    const saved = await call<ProviderView>('image.providers.save', PROVIDER)
    expect(saved).toMatchObject({
      imageTimeoutSeconds: 900,
      imageResponseMode: 'auto',
    })
    expect(saved).not.toHaveProperty('apiKey')
    expect((await store.read()).providers[0]).toMatchObject({
      imageTimeoutSeconds: 900,
      imageResponseMode: 'auto',
    })
    expect(await call('image.providers.list')).toMatchObject({
      items: [saved],
      modelConfigVersion: 2,
      transportSettingsVersion: 1,
    })
    expect(AI_IMAGE_METHODS).toHaveLength(21)
  })

  it('preserves omitted settings on edit and accepts explicit resets independently', async () => {
    const { call, store } = setup()
    const saved = await call<ProviderView>('image.providers.save', {
      ...PROVIDER,
      imageTimeoutSeconds: 1471,
      imageResponseMode: 'stream',
    })
    expect(
      await call('image.providers.save', {
        ...PROVIDER,
        id: saved.id,
        name: 'Renamed',
        apiKey: undefined,
      }),
    ).toMatchObject({
      imageTimeoutSeconds: 1471,
      imageResponseMode: 'stream',
    })
    expect(
      await call('image.providers.save', {
        ...PROVIDER,
        id: saved.id,
        imageResponseMode: 'json',
      }),
    ).toMatchObject({ imageTimeoutSeconds: 1471, imageResponseMode: 'json' })
    expect(
      await call('image.providers.save', {
        ...PROVIDER,
        id: saved.id,
        imageTimeoutSeconds: 900,
        imageResponseMode: 'auto',
      }),
    ).toMatchObject({ imageTimeoutSeconds: 900, imageResponseMode: 'auto' })
    expect((await store.read()).providers).toHaveLength(1)
    expect(requestImages).not.toHaveBeenCalled()
  })
})

describe('configured request transport', () => {
  it.each([
    {
      method: 'image.generate',
      imageTimeoutSeconds: 60,
      imageResponseMode: 'json',
      timeoutMs: 60000,
    },
    {
      method: 'image.generate',
      imageTimeoutSeconds: 3600,
      imageResponseMode: 'stream',
      timeoutMs: 3600000,
    },
    {
      method: 'image.providers.testImage',
      imageTimeoutSeconds: 900,
      imageResponseMode: 'auto',
      timeoutMs: 900000,
    },
    {
      method: 'image.providers.testImage',
      imageTimeoutSeconds: 1471,
      imageResponseMode: 'json',
      timeoutMs: 1471000,
    },
  ])(
    'forwards saved settings for $method: $imageResponseMode',
    async ({ method, timeoutMs, ...settings }) => {
      const { call, idle } = setup()
      const provider = await call<ProviderView>('image.providers.save', {
        ...PROVIDER,
        ...settings,
      })
      await call(
        method,
        method === 'image.generate'
          ? { ...GENERATE, providerId: provider.id }
          : {
              id: provider.id,
              model: provider.imageModel,
              mode: 'generate',
              prompt: 'A blue cup.',
              size: 'auto',
              inputFileIds: [],
            },
      )
      expect((await idle()).records[0]?.status).toBe('success')
      expect(requestImages).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          model: 'exact-image-model',
          timeoutMs,
          responseMode: settings.imageResponseMode,
        }),
      )
      expect(requestVision).not.toHaveBeenCalled()
    },
  )

  it('gives pre-generation and output recognition five minutes while honoring a shorter image deadline', async () => {
    const { call, images, idle } = setup()
    const provider = await call<ProviderView>('image.providers.save', {
      ...PROVIDER,
      imageTimeoutSeconds: 60,
      imageResponseMode: 'json',
    })
    await images.write('reference', 'image/png', PNG)
    const { record } = await call<{ record: GenerationRecord }>('image.generate', {
      ...GENERATE,
      providerId: provider.id,
      mode: 'edit',
      inputFileIds: ['reference'],
      visionProviderId: provider.id,
      visionModel: provider.visionModel,
    })
    expect((await idle()).records[0]?.status).toBe('success')
    expect(requestVision).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ model: 'exact-vision-model', timeoutMs: 300000 }),
    )
    expect(requestImages).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ timeoutMs: 60000, responseMode: 'json' }),
    )
    await call('image.records.recognize', {
      id: record.id,
      providerId: provider.id,
      model: provider.visionModel,
    })
    expect((await idle()).records[0]?.outputVision?.status).toBe('success')
    expect(requestVision).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: 'exact-vision-model', timeoutMs: 300000 }),
    )
  })

  it('passes transport settings to every scene view and five minutes to its planner', async () => {
    const { call, images, idle } = setup()
    const provider = await call<ProviderView>('image.providers.save', {
      ...PROVIDER,
      imageTimeoutSeconds: 1800,
      imageResponseMode: 'stream',
    })
    await images.write('reference', 'image/png', PNG)
    const { plan } = await call<{ plan: ScenePlan }>('image.plans.create', {
      providerId: provider.id,
      model: provider.visionModel,
      inputFileId: 'reference',
      requirements: 'Preserve defects.',
      count: 2,
    })
    await idle()
    expect(requestScenePlan).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ timeoutMs: 300000 }),
    )
    await call('image.generate', {
      ...GENERATE,
      providerId: provider.id,
      mode: 'edit',
      inputFileIds: ['reference'],
      count: 2,
      scenePlan: { id: plan.id, prompt: PLAN.prompt, views: PLAN.views },
    })
    const document = await idle()
    expect(document.records[0]?.status).toBe('success')
    expect(document.records[0]?.outputs).toHaveLength(2)
    expect(requestImages).toHaveBeenCalledTimes(2)
    for (const call of vi.mocked(requestImages).mock.calls) {
      expect(call[0]).toMatchObject({
        model: 'exact-image-model',
        count: 1,
        timeoutMs: 1800000,
        responseMode: 'stream',
      })
    }
    expect(requestVision).not.toHaveBeenCalled()
  })
})
