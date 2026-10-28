import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AiImage } from './ai-image.js'
import { PRESERVE } from '../domain/presets.js'
import type { GenerationRecord, ProviderView, ScenePlan } from '../domain/types.js'
import { createMemoryImageStore } from '../store/image-files.js'
import {
  createFileStore,
  createMemoryStore,
  type PrivateStore,
} from '../store/private-store.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const SECOND = Buffer.concat([PNG, Buffer.from('selected')])
const RECOGNITION = {
  title: 'Used blue mug',
  description: 'A blue mug with a chipped rim and the visible marking ABC.',
  prompt: 'Photograph the same chipped mug in natural light. Preserve ABC exactly.',
}
const PLAN = {
  ...RECOGNITION,
  translatedRequirements: 'Preserve every letter.',
  product: 'Mug',
  material: 'Appears ceramic',
  observations: 'A chipped rim and readable ABC marking.',
  uncertainties: 'The underside is not visible.',
  presetId: 'wood-desk',
  reason: 'A stable household table suits this item.',
  views: [{ id: 'front', label: 'Front', prompt: 'Show the evidenced front face.' }],
}
const PROVIDER = {
  name: 'Both models',
  kind: 'openai_compatible',
  baseUrl: 'https://selected.test/v1',
  apiKey: 'synthetic-test-key',
  imageModel: 'image-selected',
  visionModel: 'vision-selected',
}
const GENERATE = {
  imageModel: 'image-selected',
  mode: 'generate',
  presetId: null,
  prompt: '  Preserve every letter.\nUSER-END  ',
  size: 'auto',
  count: 1,
  inputFileIds: [],
}
const directories: string[] = []

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function chat(value: unknown) {
  return json({ choices: [{ message: { content: JSON.stringify(value) } }] })
}

function images() {
  return json({ data: [{ b64_json: PNG.toString('base64') }] })
}

function setup(store: PrivateStore = createMemoryStore()) {
  const files = createMemoryImageStore()
  const plugin = new AiImage({
    store,
    images: files,
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
  return { plugin, files, store, call }
}

type Instance = ReturnType<typeof setup>
type Selection = { providerId: string; model: string } | null
type ProviderList = {
  items: ProviderView[]
  storageDurable: boolean
  modelConfigVersion: number
  selections: { image: Selection; vision: Selection }
}

async function configured(store?: PrivateStore) {
  const instance = setup(store)
  const provider = await instance.call<ProviderView>('image.providers.save', PROVIDER)
  await instance.files.write('first', 'image/png', PNG)
  await instance.files.write('second', 'image/png', SECOND)
  return { ...instance, provider }
}

async function idle(instance: Instance) {
  await vi.waitFor(() => {
    expect(instance.plugin.status()['running']).toBe(0)
    expect(instance.plugin.status()['runningPlans']).toBe(0)
  })
  return instance.store.read()
}

function fetchModels(vision: unknown = RECOGNITION) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url) => (url.endsWith('/chat/completions') ? chat(vision) : images()),
  )
  vi.stubGlobal('fetch', fetch)
  return fetch
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'nexus-two-model-'))
  directories.push(path)
  return path
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('two-model provider contract', () => {
  it.each([
    { imageModel: 'image-selected', visionModel: '' },
    { imageModel: '', visionModel: 'vision-selected' },
    { imageModel: 'image-selected', visionModel: 'vision-selected' },
  ])('accepts either or both models, with no implicit selection: %j', async (models) => {
    const instance = setup()
    const provider = await instance.call<ProviderView>('image.providers.save', {
      ...PROVIDER,
      ...models,
    })
    expect(provider).toMatchObject(models)
    expect(provider).not.toHaveProperty('textModel')
    expect(provider).not.toHaveProperty('supportsVision')
    expect(provider).not.toHaveProperty('apiKey')
    expect(await instance.call('image.providers.list')).toMatchObject({
      items: [provider],
      modelConfigVersion: 2,
      selections: { image: null, vision: null },
    })
    await instance.call('image.providers.save', {
      ...PROVIDER,
      apiKey: undefined,
      ...models,
      id: provider.id,
      name: 'Renamed',
    })
    expect((await instance.store.read()).providers[0]?.apiKey).toBe(PROVIDER.apiKey)
  })

  it.each([
    { imageModel: '', visionModel: '' },
    { imageModel: '', visionModel: '', textModel: 'old-copy', supportsVision: true },
    { imageModel: 'image', visionModel: '', textModel: 'old-copy' },
  ])('rejects empty configuration and legacy active fields: %j', async (models) => {
    const instance = setup()
    await expect(
      instance.call('image.providers.save', { ...PROVIDER, ...models }),
    ).rejects.toThrow()
    expect((await instance.store.read()).providers).toEqual([])
  })
})

describe('explicit model selection', () => {
  it.each([
    '标题：蓝色杯子\n请在客厅用手机随手拍，保留缺口',
    'Titre : tasse bleue\nPhoto dans le salon, conserver la fissure.',
  ])(
    'uses English recognition without copying original requirements into image requests: %s',
    async (prompt) => {
      const instance = await configured()
      const calls = fetchModels()
      await instance.call('image.generate', {
        ...GENERATE,
        providerId: instance.provider.id,
        mode: 'edit',
        prompt,
        inputFileIds: ['first'],
        visionProviderId: instance.provider.id,
        visionModel: 'vision-selected',
      })
      const record = (await idle(instance)).records[0]
      expect(record).toMatchObject({
        status: 'success',
        title: RECOGNITION.title,
        description: RECOGNITION.description,
      })
      expect(record?.basePrompt).toContain(prompt)
      expect(String(calls.mock.calls[0]?.[1]?.body)).toContain(prompt.split('\n')[0])
      const sent = String((calls.mock.calls[1]?.[1]?.body as FormData).get('prompt'))
      expect(sent).not.toContain(prompt)
      expect(sent).not.toMatch(/\p{Script=Han}/u)
      expect(sent).toContain(RECOGNITION.prompt)
      expect(sent).toContain('handheld smartphone')
      expect(record?.prompt).toBe(sent)
      expect(calls).toHaveBeenCalledTimes(2)
    },
  )

  it('rejects untranslated text-only generation before accepting a record or charging', async () => {
    const instance = await configured()
    const calls = fetchModels()
    await expect(
      instance.call('image.generate', {
        ...GENERATE,
        providerId: instance.provider.id,
        prompt: '在客厅拍摄杯子',
      }),
    ).rejects.toThrow('英文')
    expect((await instance.store.read()).records).toHaveLength(0)
    expect(calls).not.toHaveBeenCalled()
  })

  it('allows automatic edit prompts with empty user text, while pure text requires text or a preset', async () => {
    const instance = await configured()
    const calls = fetchModels()
    await expect(
      instance.call('image.generate', {
        ...GENERATE,
        providerId: instance.provider.id,
        prompt: '',
      }),
    ).rejects.toThrow()
    expect(calls).not.toHaveBeenCalled()
    await instance.call('image.generate', {
      ...GENERATE,
      providerId: instance.provider.id,
      prompt: '',
      mode: 'edit',
      inputFileIds: ['first'],
      visionProviderId: instance.provider.id,
      visionModel: 'vision-selected',
    })
    const document = await idle(instance)
    expect(document.records[0]).toMatchObject({
      status: 'success',
      basePrompt: expect.stringContaining('handheld smartphone'),
      title: RECOGNITION.title,
      description: RECOGNITION.description,
    })
    expect(document.records[0]?.prompt).toContain(RECOGNITION.prompt)
    expect(document.records[0]?.prompt).toContain(PRESERVE)
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('keeps valid recognition at the exact field limits without truncating listing text or its prompt', async () => {
    const instance = await configured()
    const recognized = {
      title: `  ${'t'.repeat(496)}  `,
      description: `  ${'d'.repeat(5996)}  `,
      prompt: `  ${'p'.repeat(5996)}  `,
    }
    const calls = fetchModels(recognized)
    await instance.call('image.generate', {
      ...GENERATE,
      providerId: instance.provider.id,
      mode: 'edit',
      inputFileIds: ['first'],
      visionProviderId: instance.provider.id,
      visionModel: 'vision-selected',
    })
    expect((await idle(instance)).records[0]).toMatchObject({
      status: 'success',
      title: recognized.title,
      description: recognized.description,
      vision: recognized,
    })
    const form = calls.mock.calls[1]?.[1]?.body as FormData
    expect(form.get('prompt')).toContain(recognized.prompt)
  })

  it.each(['generate', 'plan', 'recognize'] as const)(
    'rejects a model changed while %s is reading its image, before remembering or charging',
    async (operation) => {
      const instance = await configured()
      const calls = fetchModels()
      const { record } = await instance.call<{ record: GenerationRecord }>(
        'image.generate',
        {
          ...GENERATE,
          providerId: instance.provider.id,
        },
      )
      await idle(instance)
      const before = await instance.store.read()
      calls.mockClear()
      const read = instance.files.readAll.bind(instance.files)
      vi.spyOn(instance.files, 'readAll').mockImplementationOnce(async (id) => {
        await instance.call('image.providers.save', {
          ...PROVIDER,
          id: instance.provider.id,
          imageModel: 'image-changed',
          visionModel: 'vision-changed',
        })
        return read(id)
      })
      const request =
        operation === 'generate'
          ? instance.call('image.generate', {
              ...GENERATE,
              providerId: instance.provider.id,
              mode: 'edit',
              inputFileIds: ['first'],
              visionProviderId: instance.provider.id,
              visionModel: 'vision-selected',
            })
          : operation === 'plan'
            ? instance.call('image.plans.create', {
                providerId: instance.provider.id,
                model: 'vision-selected',
                inputFileId: 'first',
                requirements: '',
                count: 1,
              })
            : instance.call('image.records.recognize', {
                id: record.id,
                providerId: instance.provider.id,
                model: 'vision-selected',
              })
      await expect(request).rejects.toThrow('当前配置不一致')
      const after = await idle(instance)
      expect(after.records).toEqual(before.records)
      expect(after.plans).toEqual(before.plans)
      expect(after.selections).toEqual(before.selections)
      expect(calls).not.toHaveBeenCalled()
    },
  )

  it('rejects omitted and stale models before accepting any paid task', async () => {
    const instance = await configured()
    const calls = fetchModels()
    const { record } = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      { ...GENERATE, providerId: instance.provider.id },
    )
    await idle(instance)
    const before = await instance.store.read()
    calls.mockClear()
    for (const model of [undefined, '', 'stale-model']) {
      await expect(
        instance.call('image.generate', {
          ...GENERATE,
          providerId: instance.provider.id,
          imageModel: model,
        }),
      ).rejects.toThrow()
      await expect(
        instance.call('image.plans.create', {
          providerId: instance.provider.id,
          model,
          inputFileId: 'first',
          requirements: '',
          count: 1,
        }),
      ).rejects.toThrow()
      await expect(
        instance.call('image.records.recognize', {
          id: record.id,
          providerId: instance.provider.id,
          model,
        }),
      ).rejects.toThrow()
    }
    for (const selection of [
      {},
      { visionProviderId: instance.provider.id },
      { visionModel: 'vision-selected' },
      { visionProviderId: instance.provider.id, visionModel: 'stale-model' },
    ]) {
      await expect(
        instance.call('image.generate', {
          ...GENERATE,
          providerId: instance.provider.id,
          mode: 'edit',
          inputFileIds: ['first'],
          ...selection,
        }),
      ).rejects.toThrow()
    }
    expect(await instance.store.read()).toEqual(before)
    expect(calls).not.toHaveBeenCalled()
  })

  it('executes exactly vision then image and preserves all three recognition outputs and constraints', async () => {
    const instance = await configured()
    const calls = fetchModels()
    const { record } = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      {
        ...GENERATE,
        providerId: instance.provider.id,
        mode: 'edit',
        presetId: 'wood-desk',
        inputFileIds: ['first', 'second'],
        visionProviderId: instance.provider.id,
        visionModel: 'vision-selected',
        visionFileId: 'second',
      },
    )
    await idle(instance)
    const finished = (
      await instance.call<{ record: GenerationRecord }>('image.records.get', {
        id: record.id,
      })
    ).record
    expect(finished).toMatchObject({
      status: 'success',
      title: RECOGNITION.title,
      description: RECOGNITION.description,
      vision: { ...RECOGNITION, inputFileId: 'second', model: 'vision-selected' },
    })
    expect(finished).not.toHaveProperty('textModel')
    expect(finished).not.toHaveProperty('copySupportsVision')
    expect(calls.mock.calls.map(([url]) => url)).toEqual([
      'https://selected.test/v1/chat/completions',
      'https://selected.test/v1/images/edits',
    ])
    const recognition = JSON.parse(String(calls.mock.calls[0]?.[1]?.body)) as {
      model: string
      messages: { content: { type: string; image_url?: { url: string } }[] }[]
    }
    expect(recognition.model).toBe('vision-selected')
    expect(
      recognition.messages[1]?.content.filter((part) => part.type === 'image_url'),
    ).toEqual([
      {
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${SECOND.toString('base64')}`,
        },
      },
    ])
    expect(JSON.stringify(recognition)).toContain('USER-END')
    const form = calls.mock.calls[1]?.[1]?.body as FormData
    expect(form.get('model')).toBe('image-selected')
    expect(form.getAll('image[]')).toHaveLength(2)
    for (const expected of [PRESERVE, RECOGNITION.prompt, RECOGNITION.description]) {
      expect(form.get('prompt')).toContain(expected)
    }
    expect(finished.prompt).toBe(form.get('prompt'))
  })

  it.each([
    { title: undefined },
    { title: '' },
    { title: 'x'.repeat(501) },
    { description: undefined },
    { description: ' ' },
    { description: 'x'.repeat(6001) },
    { prompt: undefined },
    { prompt: '' },
    { prompt: 'x'.repeat(6001) },
    { title: '中文标题' },
    { description: '蓝色杯子，有缺口' },
    { prompt: '在桌面上拍摄' },
  ])(
    'rejects incomplete or unbounded recognition without image requests: %j',
    async (patch) => {
      const instance = await configured()
      const calls = fetchModels({ ...RECOGNITION, ...patch })
      await instance.call('image.generate', {
        ...GENERATE,
        providerId: instance.provider.id,
        mode: 'edit',
        inputFileIds: ['first'],
        visionProviderId: instance.provider.id,
        visionModel: 'vision-selected',
      })
      const document = await idle(instance)
      expect(document.records[0]).toMatchObject({ status: 'failed', outputs: [] })
      expect(calls).toHaveBeenCalledTimes(1)
    },
  )
})

describe('durable selections and historical data', () => {
  it('remembers the accepted image/vision pairs even when the task fails, and a frozen retry does not change newer selections', async () => {
    const path = await directory()
    const instance = await configured(createFileStore(path))
    fetchModels({ description: 'Legacy description-only response must fail.' })
    const { record } = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      {
        ...GENERATE,
        providerId: instance.provider.id,
        mode: 'edit',
        inputFileIds: ['second'],
        visionProviderId: instance.provider.id,
        visionModel: 'vision-selected',
      },
    )
    expect((await idle(instance)).records[0]?.status).toBe('failed')
    const readSelections = async () =>
      (await setup(createFileStore(path)).call<ProviderList>('image.providers.list'))
        .selections
    expect(await readSelections()).toEqual({
      image: { providerId: instance.provider.id, model: 'image-selected' },
      vision: { providerId: instance.provider.id, model: 'vision-selected' },
    })
    await instance.call('image.providers.save', {
      ...PROVIDER,
      id: instance.provider.id,
      imageModel: 'image-new',
      visionModel: '',
    })
    const other = await instance.call<ProviderView>('image.providers.save', {
      ...PROVIDER,
      name: 'Other',
      visionModel: 'vision-new',
    })
    fetchModels(PLAN)
    await instance.call('image.plans.create', {
      providerId: other.id,
      model: 'vision-new',
      inputFileId: 'first',
      requirements: '',
      count: 1,
    })
    await idle(instance)
    const selections = await readSelections()
    const calls = fetchModels()
    await instance.call('image.records.retry', { id: record.id })
    const saved = (await idle(instance)).records.find((entry) => entry.id === record.id)
    expect(saved?.status).toBe('success')
    expect(JSON.parse(String(calls.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'vision-selected',
    })
    expect((calls.mock.calls[1]?.[1]?.body as FormData).get('model')).toBe(
      'image-selected',
    )
    expect(await readSelections()).toEqual(selections)
  })

  it('persists accepted pairs through restart, scene reuse and output recognition; retains stale choices without fallback', async () => {
    const path = await directory()
    const instance = await configured(createFileStore(path))
    const other = await instance.call<ProviderView>('image.providers.save', {
      ...PROVIDER,
      name: 'Other',
      visionModel: 'other-vision',
    })
    fetchModels(PLAN)
    const { plan } = await instance.call<{ plan: ScenePlan }>('image.plans.create', {
      providerId: instance.provider.id,
      model: 'vision-selected',
      inputFileId: 'second',
      requirements: '',
      count: 1,
    })
    await idle(instance)
    const list = () =>
      setup(createFileStore(path)).call<ProviderList>('image.providers.list')
    expect((await list()).selections).toEqual({
      image: null,
      vision: { providerId: instance.provider.id, model: 'vision-selected' },
    })
    const calls = fetchModels()
    const { record } = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      {
        ...GENERATE,
        providerId: instance.provider.id,
        mode: 'edit',
        inputFileIds: ['second'],
        scenePlan: { id: plan.id, prompt: PLAN.prompt, views: PLAN.views },
      },
    )
    const document = await idle(instance)
    expect(document.records[0]).toMatchObject({
      title: PLAN.title,
      description: PLAN.description,
      status: 'success',
    })
    expect(calls.mock.calls.map(([url]) => url)).toEqual([
      'https://selected.test/v1/images/edits',
    ])
    expect((await list()).selections.image).toEqual({
      providerId: instance.provider.id,
      model: 'image-selected',
    })
    await instance.call('image.records.recognize', {
      id: record.id,
      providerId: other.id,
      model: 'other-vision',
    })
    expect((await idle(instance)).records[0]?.outputVision).toMatchObject({
      ...RECOGNITION,
      status: 'success',
      model: 'other-vision',
    })
    expect((await list()).selections.vision).toEqual({
      providerId: other.id,
      model: 'other-vision',
    })
    await instance.call('image.providers.save', {
      ...PROVIDER,
      id: other.id,
      visionModel: 'changed',
    })
    await instance.call('image.providers.remove', { id: instance.provider.id })
    expect((await list()).selections).toEqual({
      image: { providerId: instance.provider.id, model: 'image-selected' },
      vision: { providerId: other.id, model: 'other-vision' },
    })
  })

  it.each(['generate', 'plan', 'recognize', 'provider'] as const)(
    'does not accept or remember %s when the atomic disk write fails',
    async (operation) => {
      const path = await directory()
      const instance = await configured(createFileStore(path))
      const calls = fetchModels()
      const { record } = await instance.call<{ record: GenerationRecord }>(
        'image.generate',
        {
          ...GENERATE,
          providerId: instance.provider.id,
        },
      )
      await idle(instance)
      const before = await instance.store.read()
      const text = await readFile(join(path, 'ai-image.json'), 'utf8')
      await mkdir(join(path, 'ai-image.json.tmp'))
      calls.mockClear()
      const request =
        operation === 'generate'
          ? instance.call('image.generate', {
              ...GENERATE,
              providerId: instance.provider.id,
              mode: 'edit',
              inputFileIds: ['second'],
              visionProviderId: instance.provider.id,
              visionModel: 'vision-selected',
            })
          : operation === 'plan'
            ? instance.call('image.plans.create', {
                providerId: instance.provider.id,
                model: 'vision-selected',
                inputFileId: 'second',
                requirements: '',
                count: 1,
              })
            : operation === 'recognize'
              ? instance.call('image.records.recognize', {
                  id: record.id,
                  providerId: instance.provider.id,
                  model: 'vision-selected',
                })
              : instance.call('image.providers.save', {
                  ...PROVIDER,
                  id: instance.provider.id,
                  imageModel: 'changed',
                })
      await expect(request).rejects.toThrow('未保存')
      expect(await instance.store.read()).toEqual(before)
      expect(await readFile(join(path, 'ai-image.json'), 'utf8')).toBe(text)
      expect(calls).not.toHaveBeenCalled()
      await idle(instance)
    },
  )

  it('reads copy-only legacy configurations without inferring vision, preserving unknown fields on reconfiguration', async () => {
    const path = await directory()
    const legacy = {
      ...PROVIDER,
      id: 'legacy',
      imageModel: '',
      visionModel: undefined,
      textModel: 'old-copy',
      supportsVision: true,
      futureProvider: { keep: 'exact' },
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }
    await writeFile(
      join(path, 'ai-image.json'),
      JSON.stringify({
        schemaVersion: 1,
        futureDocument: 'keep',
        providers: [legacy],
        records: [],
      }),
    )
    const instance = setup(createFileStore(path))
    const list = await instance.call<ProviderList>('image.providers.list')
    expect(list.items[0]).toMatchObject({ imageModel: '', visionModel: '' })
    expect(list.items[0]).not.toHaveProperty('textModel')
    expect(list.selections).toEqual({ image: null, vision: null })
    await expect(
      instance.call('image.providers.save', {
        ...PROVIDER,
        id: 'legacy',
        imageModel: '',
        visionModel: '',
      }),
    ).rejects.toThrow()
    await instance.call('image.providers.save', { ...PROVIDER, id: 'legacy' })
    expect(JSON.parse(await readFile(join(path, 'ai-image.json'), 'utf8'))).toMatchObject(
      {
        futureDocument: 'keep',
        providers: [
          {
            textModel: 'old-copy',
            supportsVision: true,
            futureProvider: { keep: 'exact' },
          },
        ],
      },
    )
  })
})
