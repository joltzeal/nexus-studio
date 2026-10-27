import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AiImage } from './ai-image.js'
import { createAiImagePlugin } from '../index.js'
import { unavailable } from '../domain/errors.js'
import { generationSummary } from '../domain/generation-summary.js'
import { PRESERVE, SCENE_PRESETS } from '../domain/presets.js'
import {
  MAX_PLANS,
  MAX_RECORDS,
  type GenerationRecord,
  type GenerationSummary,
  type ProviderView,
  type ScenePlan,
  type ScenePlanResult,
} from '../domain/types.js'
import {
  createFileStore,
  createMemoryStore,
  type PrivateStore,
  type StoreDocument,
} from '../store/private-store.js'
import {
  createFileImageStore,
  createMemoryImageStore,
  type ImageStore,
} from '../store/image-files.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const SECOND = Buffer.from([...PNG.subarray(0, 8), 2])
const SOURCE = {
  pluginId: 'studio.vinted-monitor',
  itemId: 'vinted.fr:123',
  title: 'SOURCE-METADATA-MUST-NOT-REACH-A-MODEL',
  url: 'https://vinted.fr/items/123',
}
const directories: string[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function chat(value: unknown): Response {
  return json({ choices: [{ message: { content: JSON.stringify(value) } }] })
}

function image(): Response {
  return json({ data: [{ b64_json: PNG.toString('base64') }] })
}

function result(count = 3): ScenePlanResult {
  return {
    title: '装饰画牌',
    description: '边角有磨损，保留原字样。',
    product: '有磨损的装饰画牌',
    material: '疑似印刷金属薄板，单张照片不足以确认材质',
    observations: '正面图案完整可见，边角有磨损；保留原文字。',
    uncertainties: '无法确认背面、厚度、安装方式及是否有画布纹理。',
    presetId: 'home-sofa',
    reason: '客厅背景适合此类家居装饰，不能把金属画牌改成画布。',
    prompt: 'Place the same visible item in a modest Western living room in daylight.',
    views: [
      {
        id: 'context',
        label: '客厅全景',
        prompt: 'Show the visible front with modest living-room context.',
      },
      {
        id: 'front',
        label: '正面近景',
        prompt: 'Crop closely to the visible front, keeping all markings legible.',
      },
      {
        id: 'wear',
        label: '磨损细节',
        prompt: 'Show the evidenced worn corner in a closer crop of the same front.',
      },
      {
        id: 'wide',
        label: '正面留白',
        prompt: 'Use a wider front-facing composition with natural negative space.',
      },
    ].slice(0, count),
  }
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const mocked = vi.fn(async (url: string, init?: RequestInit) => handler(url, init))
  vi.stubGlobal('fetch', mocked)
  return mocked
}

function setup(
  store: PrivateStore = createMemoryStore(),
  images: ImageStore = createMemoryImageStore(),
) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const plugin = new AiImage({
    store,
    images,
    logger,
    now: () => new Date('2026-10-25T12:00:00.000Z'),
    idFactory: randomUUID,
  })
  const call = <T>(method: string, payload: unknown): Promise<T> =>
    plugin.call({
      requestId: randomUUID(),
      capability: 'image.provider',
      method,
      payload,
      deadlineAt: Date.now() + 5000,
      assertAlive: () => undefined,
    }) as Promise<T>
  return { plugin, store, images, call, logger }
}

type Instance = ReturnType<typeof setup>

async function provider(instance: Instance, extra: Record<string, unknown> = {}) {
  return instance.call<ProviderView>('image.providers.save', {
    name: 'selected provider',
    kind: 'openai_compatible',
    baseUrl: 'https://selected.example.test/v1',
    apiKey: 'sk-test-only',
    imageModel: 'image-frozen',
    visionModel: 'vision-frozen',

    ...extra,
  })
}

async function configured(store?: PrivateStore, images?: ImageStore) {
  const instance = setup(store, images)
  const saved = await provider(instance)
  const first = await instance.images.write('first', 'image/png', PNG)
  const selected = await instance.images.write('selected', 'image/png', SECOND)
  return { ...instance, provider: saved, first, selected }
}

async function waitPlan(instance: Instance, id: string): Promise<ScenePlan> {
  return vi.waitFor(async () => {
    const { plan } = await instance.call<{ plan: ScenePlan }>('image.plans.get', { id })
    expect(plan.status).not.toBe('running')
    expect(instance.plugin.status()['runningPlans']).toBe(0)
    return plan
  })
}

async function waitRecord(instance: Instance, id: string): Promise<GenerationRecord> {
  return vi.waitFor(async () => {
    const { record } = await instance.call<{ record: GenerationRecord }>(
      'image.records.get',
      { id },
    )
    expect(record.status).not.toBe('running')
    expect(instance.plugin.status()['running']).toBe(0)
    return record
  })
}

async function planned(count = 3, store?: PrivateStore, images?: ImageStore) {
  const instance = await configured(store, images)
  mockFetch(() => chat(result(count)))
  const { plan } = await instance.call<{ plan: ScenePlan }>('image.plans.create', {
    providerId: instance.provider.id,
    model: instance.provider.visionModel,
    inputFileId: instance.selected.id,
    requirements: '客厅自然光，保留磨损',
    count,
  })
  const completed = await waitPlan(instance, plan.id)
  expect(completed.status).toBe('success')
  return { ...instance, plan: completed }
}

function generation(instance: Awaited<ReturnType<typeof planned>>) {
  return {
    providerId: instance.provider.id,
    imageModel: instance.provider.imageModel,
    mode: 'edit',
    presetId: 'wood-desk',
    prompt: '  Keep the exact red lettering.\nEND-USER-CONSTRAINT  ',
    size: 'auto',
    count: instance.plan.count,
    inputFileIds: [instance.first.id, instance.selected.id],
    source: SOURCE,
    scenePlan: {
      id: instance.plan.id,
      prompt: 'Edited shared scene: a modest wooden desk beside a window.',
      views: result(instance.plan.count).views.map((view) => ({
        ...view,
        prompt: `Edited view: ${view.prompt}`,
      })),
    },
  }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('scene planning RPC', () => {
  it('advertises create/get through the real handshake without manifest changes', () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const lines: string[] = []
    output.on('data', (chunk: Buffer) => lines.push(chunk.toString()))
    const instance = createAiImagePlugin({
      input,
      output,
      diagnostics: new PassThrough(),
    })
    instance.server.start()
    input.write(`${JSON.stringify({ type: 'handshake', protocolVersion: 1 })}\n`)
    const ready = lines
      .map((line) => JSON.parse(line) as { type: string; methods?: string[] })
      .find((entry) => entry.type === 'ready')
    expect(ready?.methods).toContain('image.plans.create')
    expect(ready?.methods).toContain('image.plans.get')
    instance.server.stop()
  })

  it('persists running before one selected vision request, with all presets and uncut requirements', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-scene-plan-'))
    directories.push(directory)
    const instance = await configured(createFileStore(directory))
    await provider(instance, { name: 'other', visionModel: 'wrong-model' })
    const pending = deferred<Response>()
    const calls = mockFetch(() => pending.promise)
    const requirements = `  客厅，保持商品原状\n${'x'.repeat(11000)} END  `
    const { plan } = await instance.call<{ plan: ScenePlan }>('image.plans.create', {
      providerId: instance.provider.id,
      model: instance.provider.visionModel,
      inputFileId: instance.selected.id,
      requirements,
      count: 3,
    })
    try {
      expect(plan.status).toBe('running')
      expect((await createFileStore(directory).read()).plans[0]).toEqual(plan)
      expect(
        (await instance.call<{ plan: ScenePlan }>('image.plans.get', { id: plan.id }))
          .plan.status,
      ).toBe('running')
      expect(calls).toHaveBeenCalledTimes(1)
      expect(calls.mock.calls[0]?.[0]).toBe(
        'https://selected.example.test/v1/chat/completions',
      )
      const body = JSON.parse(String(calls.mock.calls[0]?.[1]?.body)) as {
        model: string
        messages: {
          role: string
          content: string | { type: string; text?: string; image_url?: { url: string } }[]
        }[]
      }
      expect(body.model).toBe('vision-frozen')
      const content = body.messages[1]?.content
      expect(Array.isArray(content)).toBe(true)
      if (!Array.isArray(content)) throw new Error('missing content')
      expect(content.filter((part) => part.type === 'image_url')).toEqual([
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${SECOND.toString('base64')}` },
        },
      ])
      const text = content[0]?.text ?? ''
      expect(text).toContain(requirements)
      expect(text).toContain('exactly 3 views')
      for (const preset of SCENE_PRESETS) {
        expect(text).toContain(JSON.stringify(preset.id))
        expect(text).toContain(preset.category)
        expect(text).toContain(preset.hint)
      }
      const system = body.messages[0]?.content
      expect(system).toContain(PRESERVE)
      expect(system).toContain('tin/metal sign')
      expect(system).toContain('canvas')
      expect(system).toContain('living-room')
      expect(system).toContain('Simplified Chinese')
      expect(system).toContain('English')
      expect((await instance.store.read()).records).toEqual([])
    } finally {
      pending.resolve(chat(result()))
    }
    const finished = await waitPlan(instance, plan.id)
    expect(finished.result).toEqual(result())
    expect((await createFileStore(directory).read()).plans[0]).toEqual(finished)
    expect(calls).toHaveBeenCalledTimes(1)
  })

  const malformed: [string, (value: ScenePlanResult) => unknown][] = [
    ['missing title', (value) => ({ ...value, title: undefined })],
    ['blank title', (value) => ({ ...value, title: ' ' })],
    ['oversized title', (value) => ({ ...value, title: 'a'.repeat(501) })],
    ['missing description', (value) => ({ ...value, description: undefined })],
    ['blank description', (value) => ({ ...value, description: '' })],
    ['oversized description', (value) => ({ ...value, description: 'a'.repeat(6001) })],
    ['wrong count', (value) => ({ ...value, views: value.views.slice(0, 1) })],
    ['unknown preset', (value) => ({ ...value, presetId: 'invented' })],
    [
      'duplicate id',
      (value) => ({
        ...value,
        views: [
          value.views[0],
          { ...value.views[1], id: value.views[0]?.id },
          value.views[2],
        ],
      }),
    ],
    [
      'duplicate label',
      (value) => ({
        ...value,
        views: [
          value.views[0],
          { ...value.views[1], label: ` ${value.views[0]?.label} ` },
          value.views[2],
        ],
      }),
    ],
    [
      'duplicate prompt',
      (value) => ({
        ...value,
        views: [
          value.views[0],
          { ...value.views[1], prompt: value.views[0]?.prompt.toUpperCase() },
          value.views[2],
        ],
      }),
    ],
    ['missing uncertainty', (value) => ({ ...value, uncertainties: '' })],
    ['blank prompt', (value) => ({ ...value, prompt: '  ' })],
    ['oversized observations', (value) => ({ ...value, observations: 'a'.repeat(6001) })],
    ['extra field', (value) => ({ ...value, invented: true })],
    ['not an object', () => 'not a plan'],
  ]
  it.each(malformed)(
    'rejects %s without a fabricated fallback or image request',
    async (_name, transform) => {
      const instance = await configured()
      const calls = mockFetch(() => chat(transform(result())))
      const { plan } = await instance.call<{ plan: ScenePlan }>('image.plans.create', {
        providerId: instance.provider.id,
        model: instance.provider.visionModel,
        inputFileId: instance.selected.id,
        requirements: '',
        count: 3,
      })
      const finished = await waitPlan(instance, plan.id)
      expect(finished).toMatchObject({ status: 'failed', result: null })
      expect(finished.error).toBeTruthy()
      expect((await instance.store.read()).records).toHaveLength(0)
      expect(calls).toHaveBeenCalledTimes(1)
      expect(calls.mock.calls[0]?.[0]).toContain('/chat/completions')
    },
  )

  it('rejects non-JSON content and preserves the failed plan for inspection', async () => {
    const instance = await configured()
    const calls = mockFetch(() =>
      json({ choices: [{ message: { content: '```json\nbroken\n```' } }] }),
    )
    const { plan } = await instance.call<{ plan: ScenePlan }>('image.plans.create', {
      providerId: instance.provider.id,
      model: instance.provider.visionModel,
      inputFileId: instance.selected.id,
      requirements: '',
      count: 1,
    })
    expect((await waitPlan(instance, plan.id)).status).toBe('failed')
    await instance.call('image.plans.get', { id: plan.id })
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('rejects missing provider, vision model, image and invalid bounded inputs before requesting', async () => {
    const instance = await configured()
    const calls = mockFetch(() => chat(result()))
    const payload = {
      providerId: instance.provider.id,
      model: instance.provider.visionModel,
      inputFileId: instance.selected.id,
      requirements: '',
      count: 3,
    }
    for (const extra of [
      { providerId: 'missing' },
      { model: undefined },
      { model: 'stale-model' },
      { inputFileId: 'missing' },
      { count: 0 },
      { count: 5 },
      { requirements: 'a'.repeat(12001) },
      { source: SOURCE },
    ]) {
      await expect(
        instance.call('image.plans.create', { ...payload, ...extra }),
      ).rejects.toThrow()
    }
    await provider(instance, { id: instance.provider.id, visionModel: '' })
    await expect(instance.call('image.plans.create', payload)).rejects.toThrow(
      '未配置独立识图模型',
    )
    expect((await instance.store.read()).plans).toHaveLength(0)
    expect(instance.plugin.status()['runningPlans']).toBe(0)
    expect(calls).not.toHaveBeenCalled()
  })
})

describe('distinct scene views', () => {
  it('makes sequential n=1 edit calls, preserves all constraints and original bytes, without source leakage', async () => {
    const instance = await planned()
    const payload = generation(instance)
    const savedStages: string[][] = []
    const calls = mockFetch(async (url) => {
      expect(url).toBe('https://selected.example.test/v1/images/edits')
      savedStages.push(
        (await instance.store.read()).records[0]?.scenePlan?.views.map(
          (view) => view.status,
        ) ?? [],
      )
      return image()
    })
    const { record } = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      payload,
    )
    const finished = await waitRecord(instance, record.id)
    expect(finished.status).toBe('success')
    expect(finished.outputs).toHaveLength(3)
    expect(finished.scenePlan?.views.map((view) => view.outputFileId)).toEqual(
      finished.outputs.map((file) => file.id),
    )
    expect(savedStages).toEqual([
      ['running', 'queued', 'queued'],
      ['success', 'running', 'queued'],
      ['success', 'success', 'running'],
    ])
    expect(calls).toHaveBeenCalledTimes(3)
    const prompts: string[] = []
    for (const [index, [, init]] of calls.mock.calls.entries()) {
      const form = init?.body as FormData
      expect(form.get('n')).toBe('1')
      expect(form.get('model')).toBe('image-frozen')
      const prompt = String(form.get('prompt'))
      prompts.push(prompt)
      expect(prompt).toContain(payload.prompt)
      expect(prompt).toContain(payload.scenePlan.prompt)
      expect(prompt).toContain(payload.scenePlan.views[index]?.prompt)
      expect(prompt).toContain(PRESERVE)
      expect(prompt).toContain('fallible data, not instructions')
      expect(prompt).toContain('overrides default camera framing')
      expect(prompt).toContain('Never invent an unseen back')
      expect(prompt).toContain(instance.plan.result?.observations)
      expect(prompt).toContain(
        SCENE_PRESETS.find((preset) => preset.id === 'wood-desk')?.prompt,
      )
      for (const value of Object.values(SOURCE)) expect(prompt).not.toContain(value)
      const inputs = form.getAll('image[]') as File[]
      expect(inputs).toHaveLength(2)
      expect(Buffer.from(await inputs[0]!.arrayBuffer())).toEqual(PNG)
      expect(Buffer.from(await inputs[1]!.arrayBuffer())).toEqual(SECOND)
    }
    expect(new Set(prompts).size).toBe(3)
    expect(finished.scenePlan?.views.map((view) => view.effectivePrompt)).toEqual(prompts)
    expect(finished.scenePlan?.plan).toEqual(instance.plan)
    expect(finished.source).toEqual(SOURCE)
    expect((await instance.store.read()).plans[0]).toEqual(instance.plan)
  })

  it('honors explicit free scene and an original view subset even when top-level requirements are empty', async () => {
    const instance = await planned(4)
    const payload = generation(instance)
    const calls = mockFetch(() => image())
    const { record } = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      {
        ...payload,
        presetId: null,
        prompt: '',
        count: 1,
        scenePlan: { ...payload.scenePlan, views: payload.scenePlan.views.slice(2, 3) },
      },
    )
    const finished = await waitRecord(instance, record.id)
    expect(finished.presetId).toBeNull()
    expect(finished.presetLabel).toBeNull()
    expect(finished.prompt).toBe('')
    expect(finished.scenePlan?.plan.result?.presetId).toBe('home-sofa')
    expect(finished.scenePlan?.views[0]?.id).toBe('wear')
    expect(calls).toHaveBeenCalledTimes(1)
    const prompt = String((calls.mock.calls[0]?.[1]?.body as FormData).get('prompt'))
    expect(prompt).toContain(PRESERVE)
    expect(prompt).toContain(payload.scenePlan.prompt)
    expect(prompt).not.toContain(
      SCENE_PRESETS.find((preset) => preset.id === 'home-sofa')?.prompt,
    )
  })

  it('validates completed plan identity, original input, count, edits and incompatible vision fields', async () => {
    const instance = await planned()
    const payload = generation(instance)
    const calls = mockFetch(() => image())
    for (const extra of [
      { mode: 'generate' },
      { inputFileIds: ['first'] },
      { count: 2 },
      { presetId: 'missing' },
      { visionProviderId: null },
      { visionModel: null },
      { visionFileId: null },
      { scenePlan: { ...payload.scenePlan, id: 'missing' } },
      { scenePlan: { ...payload.scenePlan, prompt: ' ' } },
      {
        scenePlan: {
          ...payload.scenePlan,
          views: payload.scenePlan.views.map((view) => ({ ...view, id: 'foreign' })),
        },
      },
      {
        scenePlan: {
          ...payload.scenePlan,
          views: payload.scenePlan.views.map((view) => ({ ...view, prompt: 'same' })),
        },
      },
      { scenePlan: { ...payload.scenePlan, prompt: 'x'.repeat(6001) } },
    ]) {
      await expect(
        instance.call('image.generate', { ...payload, ...extra }),
      ).rejects.toThrow()
    }
    await instance.store.mutate((document) => {
      const plan = document.plans[0]!
      plan.status = 'failed'
      plan.result = null
      plan.error = 'invalid'
    })
    await expect(instance.call('image.generate', payload)).rejects.toThrow('尚未成功')
    expect((await instance.store.read()).records).toHaveLength(0)
    expect(calls).not.toHaveBeenCalled()
  })

  it('retains partial successes and retries only a failed view with frozen models/prompts and plan listing text', async () => {
    const instance = await planned()
    const payload = generation(instance)
    let imageCalls = 0
    const firstCalls = mockFetch(() => {
      imageCalls += 1
      return imageCalls === 2 ? json({ error: 'unsupported image format' }, 400) : image()
    })
    const { record } = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      payload,
    )
    const partial = await waitRecord(instance, record.id)
    expect(partial.status).toBe('failed')
    expect(partial.outputs).toHaveLength(2)
    expect(partial.scenePlan?.views.map((view) => view.status)).toEqual([
      'success',
      'failed',
      'success',
    ])
    expect(partial.scenePlan?.views[1]?.error).toContain('unsupported image format')
    expect(partial.title).toBe('装饰画牌')
    expect(partial.description).toBe(instance.plan.result?.description)
    expect(firstCalls).toHaveBeenCalledTimes(3)
    expect(firstCalls.mock.calls.every(([url]) => url.endsWith('/images/edits'))).toBe(
      true,
    )

    await provider(instance, {
      id: instance.provider.id,
      imageModel: 'new-image',
      visionModel: 'new-vision',
    })
    await instance.store.mutate((document) => {
      document.plans[0]!.result!.prompt = 'Changed plan after submission.'
    })
    const retryCalls = mockFetch(() => image())
    await instance.call('image.records.retry', { id: record.id })
    const finished = await waitRecord(instance, record.id)
    expect(finished.status).toBe('success')
    expect(retryCalls).toHaveBeenCalledTimes(1)
    const form = retryCalls.mock.calls[0]?.[1]?.body as FormData
    expect(form.get('model')).toBe('image-frozen')
    expect(form.get('prompt')).toBe(partial.scenePlan?.views[1]?.effectivePrompt)
    expect(finished.scenePlan?.plan).toEqual(instance.plan)
    expect(finished.outputs[0]).toEqual(partial.outputs[0])
    expect(finished.outputs[2]).toEqual(partial.outputs[1])
    expect(finished.title).toBe(partial.title)
    expect(finished.description).toBe(partial.description)
    expect(finished.source).toEqual(SOURCE)
    await expect(
      instance.call('image.records.retry', { id: record.id }),
    ).resolves.toEqual({ record: finished })
    expect(retryCalls).toHaveBeenCalledTimes(1)
  })

  it('rejects multiple returned images for n=1 without discarding another view success', async () => {
    const instance = await planned(2)
    let calls = 0
    mockFetch(() => {
      calls += 1
      return calls === 1
        ? json({
            data: [
              { b64_json: PNG.toString('base64') },
              { b64_json: PNG.toString('base64') },
            ],
          })
        : image()
    })
    const { record } = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      generation(instance),
    )
    const finished = await waitRecord(instance, record.id)
    expect(finished.status).toBe('failed')
    expect(finished.outputs).toHaveLength(1)
    expect(finished.scenePlan?.views.map((view) => view.status)).toEqual([
      'failed',
      'success',
    ])
    expect(calls).toBe(2)
  })

  it('does not charge when original input or provider is missing at retry time', async () => {
    const instance = await planned(2)
    mockFetch(() => json({ error: 'unavailable' }, 503))
    const { record } = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      generation(instance),
    )
    await waitRecord(instance, record.id)
    await instance.images.remove(instance.selected.id)
    const calls = mockFetch(() => image())
    await instance.call('image.records.retry', { id: record.id })
    const missingImage = await waitRecord(instance, record.id)
    expect(missingImage.scenePlan?.views.every((view) => view.status === 'failed')).toBe(
      true,
    )
    expect(missingImage.error).toContain('图片文件不存在')
    await instance.call('image.providers.remove', { id: instance.provider.id })
    await instance.call('image.records.retry', { id: record.id })
    expect((await waitRecord(instance, record.id)).error).toContain('请先在模型配置')
    expect(calls).not.toHaveBeenCalled()
  })
})

describe('scene lifecycle, recovery and file ownership', () => {
  it('repairs exactly one final aggregate save failure after durable views and plan text without new requests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-scene-aggregate-'))
    directories.push(directory)
    const base = createFileStore(directory)
    const failedSnapshots: GenerationRecord[] = []
    const recoveryEntered = deferred<void>()
    const resumeRecovery = deferred<void>()
    let pauseRecovery = true
    const faulted: PrivateStore = {
      kind: base.kind,
      durable: base.durable,
      read: () => base.read(),
      mutate: (apply) =>
        base.mutate(async (document) => {
          const before = structuredClone(document.records[0])
          const value = await apply(document)
          const after = document.records[0]
          if (
            before?.status === 'running' &&
            before.scenePlan?.views.every((view) => view.status === 'success') &&
            after?.stage === 'done'
          ) {
            if (failedSnapshots.length === 0) {
              expect(after.status).toBe('success')
              failedSnapshots.push(before)
              throw unavailable('final aggregate save failed')
            }
            if (pauseRecovery) {
              pauseRecovery = false
              recoveryEntered.resolve()
              await resumeRecovery.promise
            }
          }
          return value
        }),
    }
    const instance = await planned(
      3,
      faulted,
      createFileImageStore(join(directory, 'images')),
    )
    const calls = mockFetch(() => image())
    const { record } = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      generation(instance),
    )
    try {
      await recoveryEntered.promise
      const persisted = (await createFileStore(directory).read()).records[0]!
      expect(failedSnapshots).toHaveLength(1)
      expect(persisted).toEqual(failedSnapshots[0])
      expect(persisted.status).toBe('running')
      expect(persisted.outputs).toHaveLength(3)
      expect(persisted.scenePlan?.views.map((view) => view.status)).toEqual([
        'success',
        'success',
        'success',
      ])
      expect(instance.plugin.status()['running']).toBe(1)
      await expect(
        instance.call('image.records.get', { id: record.id }),
      ).resolves.toEqual({ record: persisted })
      await expect(
        instance.call('image.records.retry', { id: record.id }),
      ).rejects.toThrow('仍在生成')
    } finally {
      resumeRecovery.resolve()
    }
    await vi.waitFor(() => expect(instance.plugin.status()['running']).toBe(0))
    // Read the disk directly so RPC recovery cannot hide a broken final catch.
    const completed = (await createFileStore(directory).read()).records[0]!
    const saved = failedSnapshots[0]!
    expect(completed).toEqual({
      ...saved,
      status: 'success',
      stage: 'done',
      error: null,
      durationMs: expect.any(Number),
    })
    expect(completed.title).toBe(instance.plan.result?.title)
    expect(completed.description).toBe(instance.plan.result?.description)
    expect(instance.logger.warn).toHaveBeenCalledWith('场景生图执行或状态写入失败', {
      recordId: record.id,
      error: 'final aggregate save failed',
    })
    await expect(
      instance.call('image.records.retry', { id: record.id }),
    ).resolves.toEqual({ record: completed })
    await expect(instance.call('image.records.get', { id: record.id })).resolves.toEqual({
      record: completed,
    })
    const restarted = setup(
      createFileStore(directory),
      createFileImageStore(join(directory, 'images')),
    )
    await expect(restarted.call('image.records.get', { id: record.id })).resolves.toEqual(
      { record: completed },
    )
    expect(failedSnapshots).toHaveLength(1)
    expect(
      calls.mock.calls.filter(([url]) => url.endsWith('/images/edits')),
    ).toHaveLength(3)
    expect(
      calls.mock.calls.filter(([url]) => url.endsWith('/chat/completions')),
    ).toHaveLength(0)
    expect(calls).toHaveBeenCalledTimes(3)
  })

  it.each(['detail', 'source list', 'retry', 'restart'] as const)(
    'reconciles an old failed aggregate through %s without redoing completed views or copy',
    async (entry) => {
      const directory = await mkdtemp(join(tmpdir(), 'nexus-scene-old-aggregate-'))
      directories.push(directory)
      const instance = await planned(
        2,
        createFileStore(directory),
        createFileImageStore(join(directory, 'images')),
      )
      mockFetch(() => image())
      const { record } = await instance.call<{ record: GenerationRecord }>(
        'image.generate',
        generation(instance),
      )
      const completed = await waitRecord(instance, record.id)
      completed.copyError = 'Historical copy failure'
      completed.textModel = 'legacy-copy'
      await instance.store.mutate((document) => {
        const saved = document.records[0]!
        Object.assign(saved, completed)
        saved.status = 'failed'
        saved.error = 'final aggregate save failed'
        // Completion recovery must not need the former provider or a new API key.
        document.providers = []
      })
      const calls = mockFetch(() => image())
      const reader =
        entry === 'restart'
          ? setup(
              createFileStore(directory),
              createFileImageStore(join(directory, 'images')),
            )
          : instance
      let recovered: GenerationRecord | GenerationSummary
      if (entry === 'source list') {
        const page = await reader.call<{ items: GenerationSummary[]; total: number }>(
          'image.records.list',
          {
            page: 0,
            size: 10,
            status: 'success',
            sourcePluginId: SOURCE.pluginId,
            sourceItemId: SOURCE.itemId,
          },
        )
        expect(page.total).toBe(1)
        recovered = page.items[0]!
      } else {
        const response = await reader.call<{ record: GenerationRecord }>(
          entry === 'retry' ? 'image.records.retry' : 'image.records.get',
          { id: record.id },
        )
        recovered = response.record
      }
      expect(recovered).toEqual(
        entry === 'source list' ? generationSummary(completed) : completed,
      )
      expect((await createFileStore(directory).read()).records[0]).toEqual(completed)
      for (const output of completed.outputs) {
        expect(Buffer.from((await reader.images.readAll(output.id)).bytes)).toEqual(PNG)
      }
      const writes = vi.spyOn(reader.store, 'mutate')
      await expect(reader.call('image.records.get', { id: record.id })).resolves.toEqual({
        record: completed,
      })
      expect(writes).not.toHaveBeenCalled()
      expect(calls).not.toHaveBeenCalled()
      expect(reader.plugin.status()['running']).toBe(0)
    },
  )

  it.each(['image.records.get', 'image.records.retry'])(
    '%s rejects an unsaved aggregate reconciliation and can later recover without requests',
    async (method) => {
      const instance = await planned(1)
      mockFetch(() => image())
      const { record } = await instance.call<{ record: GenerationRecord }>(
        'image.generate',
        generation(instance),
      )
      const completed = await waitRecord(instance, record.id)
      const failed = await instance.store.mutate((document) => {
        const saved = document.records[0]!
        saved.status = 'failed'
        saved.error = 'final aggregate save failed'
        return structuredClone(saved)
      })
      const calls = mockFetch(() => image())
      vi.spyOn(instance.store, 'mutate').mockImplementationOnce(async (apply) => {
        const draft = await instance.store.read()
        await apply(draft)
        expect(draft.records[0]?.status).toBe('success')
        throw unavailable('reconciliation write failed')
      })
      await expect(instance.call(method, { id: record.id })).rejects.toThrow(
        'reconciliation write failed',
      )
      expect((await instance.store.read()).records[0]).toEqual(failed)
      expect(instance.plugin.status()['running']).toBe(0)
      expect(calls).not.toHaveBeenCalled()
      await expect(instance.call(method, { id: record.id })).resolves.toEqual({
        record: completed,
      })
      expect((await instance.store.read()).records[0]).toEqual(completed)
      expect(instance.plugin.status()['running']).toBe(0)
      expect(calls).not.toHaveBeenCalled()
    },
  )

  it('recovers plans and remaining views after restart without calls, then retries only unfinished views', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-scene-restart-'))
    directories.push(directory)
    const images = createFileImageStore(join(directory, 'images'))
    const first = await planned(3, createFileStore(directory), images)
    mockFetch(() => image())
    const { record } = await first.call<{ record: GenerationRecord }>(
      'image.generate',
      generation(first),
    )
    const complete = await waitRecord(first, record.id)
    await first.store.mutate((document) => {
      const saved = document.records[0]!
      saved.status = 'running'
      saved.stage = 'image'
      saved.outputs = saved.outputs.slice(0, 1)
      for (const [index, view] of saved.scenePlan!.views.entries()) {
        if (index === 0) continue
        view.status = index === 1 ? 'running' : 'queued'
        view.outputFileId = null
      }
      document.plans.unshift({
        ...first.plan,
        id: 'interrupted-plan',
        status: 'running',
        result: null,
      })
    })
    const restarted = setup(
      createFileStore(directory),
      createFileImageStore(join(directory, 'images')),
    )
    const calls = mockFetch(() => image())
    const page = await restarted.call<{ items: GenerationSummary[] }>(
      'image.records.list',
      {
        page: 0,
        size: 10,
        sourcePluginId: SOURCE.pluginId,
        sourceItemId: SOURCE.itemId,
      },
    )
    const recovered = page.items[0]!
    expect(recovered.status).toBe('failed')
    expect(recovered.scenePlan?.views.map((view) => view.status)).toEqual([
      'success',
      'failed',
      'failed',
    ])
    expect(recovered.outputs).toEqual(
      complete.outputs.slice(0, 1).map(({ id, mime }) => ({ id, mime })),
    )
    expect(recovered.source).toEqual(SOURCE)
    expect(recovered.scenePlan).not.toHaveProperty('plan')
    const interrupted = await restarted.call<{ plan: ScenePlan }>('image.plans.get', {
      id: 'interrupted-plan',
    })
    expect(interrupted.plan.status).toBe('failed')
    expect(interrupted.plan.error).toContain('已中断')
    expect(calls).not.toHaveBeenCalled()
    const persisted = JSON.parse(
      await readFile(join(directory, 'ai-image.json'), 'utf8'),
    ) as StoreDocument
    expect(generationSummary(persisted.records[0]!)).toEqual(recovered)
    expect(persisted.records[0]?.scenePlan?.plan).toEqual(first.plan)
    expect(persisted.plans[0]?.status).toBe('failed')

    await provider(restarted, {
      id: first.provider.id,
      imageModel: 'changed',
      visionModel: 'changed',
    })
    await restarted.call('image.records.retry', { id: record.id })
    const finished = await waitRecord(restarted, record.id)
    expect(calls).toHaveBeenCalledTimes(2)
    expect(finished.outputs[0]).toEqual(complete.outputs[0])
    expect(finished.source).toEqual(SOURCE)
    for (const [index, [, init]] of calls.mock.calls.entries()) {
      const form = init?.body as FormData
      expect(form.get('n')).toBe('1')
      expect(form.get('model')).toBe('image-frozen')
      expect(form.get('prompt')).toBe(
        complete.scenePlan?.views[index + 1]?.effectivePrompt,
      )
    }
    expect((await createFileStore(directory).read()).records[0]).toEqual(finished)
  })

  it.each(['plan', 'generation', 'retry'] as const)(
    'reserves %s before its running write becomes visible, preventing recovery/start races',
    async (kind) => {
      const original = await planned(1)
      let retryId = ''
      if (kind === 'retry') {
        mockFetch(() => json({ error: 'failed' }, 503))
        const created = await original.call<{ record: GenerationRecord }>(
          'image.generate',
          generation(original),
        )
        retryId = created.record.id
        await waitRecord(original, retryId)
      }
      const entered = deferred<void>()
      const resume = deferred<void>()
      let pause = true
      const delayed: PrivateStore = {
        kind: original.store.kind,
        durable: original.store.durable,
        read: () => original.store.read(),
        async mutate<T>(apply: (document: StoreDocument) => T | Promise<T>): Promise<T> {
          const shouldPause = pause
          pause = false
          const value = await original.store.mutate(apply)
          if (shouldPause) {
            entered.resolve()
            await resume.promise
          }
          return value
        },
      }
      const instance = setup(delayed, original.images)
      const calls = mockFetch(() => (kind === 'plan' ? chat(result(1)) : image()))
      const started =
        kind === 'plan'
          ? instance.call<{ plan: ScenePlan }>('image.plans.create', {
              providerId: original.provider.id,
              model: original.provider.visionModel,
              inputFileId: 'selected',
              requirements: '',
              count: 1,
            })
          : instance.call<{ record: GenerationRecord }>(
              kind === 'retry' ? 'image.records.retry' : 'image.generate',
              kind === 'retry' ? { id: retryId } : generation(original),
            )
      let id: string
      try {
        await entered.promise
        const document = await original.store.read()
        if (kind === 'plan') {
          id = document.plans[0]!.id
          expect(
            (await instance.call<{ plan: ScenePlan }>('image.plans.get', { id })).plan
              .status,
          ).toBe('running')
        } else {
          id = document.records[0]!.id
          const detail = await instance.call<{ record: GenerationRecord }>(
            'image.records.get',
            { id },
          )
          expect(detail.record.status).toBe('running')
          expect(detail.record.scenePlan?.views[0]?.status).toBe('queued')
          await expect(instance.call('image.records.retry', { id })).rejects.toThrow(
            '仍在生成',
          )
          await expect(instance.call('image.records.remove', { id })).rejects.toThrow(
            '仍在生成',
          )
        }
        expect(calls).not.toHaveBeenCalled()
      } finally {
        resume.resolve()
      }
      await started
      if (kind === 'plan') expect((await waitPlan(instance, id)).status).toBe('success')
      else expect((await waitRecord(instance, id)).status).toBe('success')
      expect(calls).toHaveBeenCalledTimes(1)
    },
  )

  it('does not call vision when initial persistence fails or report an unsaved plan as successful', async () => {
    const instance = await configured()
    const calls = mockFetch(() => chat(result(1)))
    const payload = {
      providerId: instance.provider.id,
      model: instance.provider.visionModel,
      inputFileId: 'selected',
      requirements: '',
      count: 1,
    }
    vi.spyOn(instance.store, 'mutate').mockRejectedValueOnce(new Error('cannot save'))
    await expect(instance.call('image.plans.create', payload)).rejects.toThrow(
      'cannot save',
    )
    expect(instance.plugin.status()['runningPlans']).toBe(0)
    expect(calls).not.toHaveBeenCalled()
    expect((await instance.store.read()).plans).toEqual([])

    const response = deferred<Response>()
    calls.mockImplementation(() => response.promise)
    const { plan } = await instance.call<{ plan: ScenePlan }>(
      'image.plans.create',
      payload,
    )
    vi.spyOn(instance.store, 'mutate').mockRejectedValueOnce(
      new Error('cannot save result'),
    )
    response.resolve(chat(result(1)))
    await vi.waitFor(() => expect(instance.plugin.status()['runningPlans']).toBe(0))
    expect((await instance.store.read()).plans[0]?.status).toBe('running')
    const recovered = await instance.call<{ plan: ScenePlan }>('image.plans.get', {
      id: plan.id,
    })
    expect(recovered.plan.status).toBe('failed')
    expect(recovered.plan.result).toBeNull()
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('protects an original image while a new plan is accepting it and its previous record is removed', async () => {
    const instance = await configured()
    mockFetch((url) =>
      url.endsWith('/chat/completions')
        ? chat({
            title: result(1).title,
            description: result(1).description,
            prompt: result(1).prompt,
          })
        : image(),
    )
    const { record } = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      {
        providerId: instance.provider.id,
        imageModel: instance.provider.imageModel,
        visionProviderId: instance.provider.id,
        visionModel: instance.provider.visionModel,
        mode: 'edit',
        presetId: 'home-sofa',
        prompt: '',
        size: 'auto',
        count: 1,
        inputFileIds: ['selected'],
      },
    )
    await waitRecord(instance, record.id)
    const reading = deferred<void>()
    const resume = deferred<void>()
    const originalRead = instance.images.readAll.bind(instance.images)
    vi.spyOn(instance.images, 'readAll').mockImplementationOnce(async (id) => {
      reading.resolve()
      await resume.promise
      return originalRead(id)
    })
    mockFetch(() => chat(result(1)))
    const creation = instance.call<{ plan: ScenePlan }>('image.plans.create', {
      providerId: instance.provider.id,
      model: instance.provider.visionModel,
      inputFileId: 'selected',
      requirements: '',
      count: 1,
    })
    try {
      await reading.promise
      await instance.call('image.records.remove', { id: record.id })
      expect(Buffer.from((await originalRead('selected')).bytes)).toEqual(SECOND)
    } finally {
      resume.resolve()
    }
    const { plan } = await creation
    expect((await waitPlan(instance, plan.id)).status).toBe('success')
    expect(Buffer.from((await originalRead('selected')).bytes)).toEqual(SECOND)
  })

  it('keeps shared inputs and generated files referenced by another plan or record on removal', async () => {
    const instance = await planned(1)
    mockFetch(() => image())
    const first = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      generation(instance),
    )
    const firstDone = await waitRecord(instance, first.record.id)
    const second = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      generation(instance),
    )
    const secondDone = await waitRecord(instance, second.record.id)
    mockFetch(() => chat(result(1)))
    const { plan } = await instance.call<{ plan: ScenePlan }>('image.plans.create', {
      providerId: instance.provider.id,
      model: instance.provider.visionModel,
      inputFileId: firstDone.outputs[0]!.id,
      requirements: '',
      count: 1,
    })
    await waitPlan(instance, plan.id)
    await instance.call('image.records.remove', { id: firstDone.id })
    expect(Buffer.from((await instance.images.readAll('first')).bytes)).toEqual(PNG)
    await instance.call('image.records.remove', { id: secondDone.id })
    expect(Buffer.from((await instance.images.readAll('selected')).bytes)).toEqual(SECOND)
    expect((await instance.images.readAll(firstDone.outputs[0]!.id)).bytes).toEqual(
      new Uint8Array(PNG),
    )
    await expect(instance.images.readAll(secondDone.outputs[0]!.id)).rejects.toThrow()
    expect(
      (
        await instance.call<{ plan: ScenePlan }>('image.plans.get', {
          id: instance.plan.id,
        })
      ).plan,
    ).toEqual(instance.plan)
  })

  it('bounds plans without pruning an active plan or deleting a reused reference', async () => {
    const instance = await planned(1)
    const response = deferred<Response>()
    let calls = 0
    mockFetch(() => {
      calls += 1
      return calls === 1 ? response.promise : chat(result(1))
    })
    const payload = {
      providerId: instance.provider.id,
      model: instance.provider.visionModel,
      inputFileId: 'selected',
      requirements: '',
      count: 1,
    }
    const active = await instance.call<{ plan: ScenePlan }>('image.plans.create', payload)
    try {
      await instance.store.mutate((document) => {
        document.plans = [
          ...Array.from({ length: MAX_PLANS - 1 }, (_, index) => ({
            ...instance.plan,
            id: `archived-${index}`,
          })),
          active.plan,
        ]
      })
      const created = await instance.call<{ plan: ScenePlan }>(
        'image.plans.create',
        payload,
      )
      await vi.waitFor(async () => {
        expect(
          (
            await instance.call<{ plan: ScenePlan }>('image.plans.get', {
              id: created.plan.id,
            })
          ).plan.status,
        ).toBe('success')
      })
      const document = await instance.store.read()
      expect(document.plans).toHaveLength(MAX_PLANS)
      expect(document.plans.find((plan) => plan.id === active.plan.id)?.status).toBe(
        'running',
      )
      expect(document.plans.some((plan) => plan.id === `archived-${MAX_PLANS - 2}`)).toBe(
        false,
      )
      expect(Buffer.from((await instance.images.readAll('selected')).bytes)).toEqual(
        SECOND,
      )
    } finally {
      response.resolve(chat(result(1)))
    }
    await waitPlan(instance, active.plan.id)
  })

  it('bounds records without pruning an active view job', async () => {
    const instance = await planned(1)
    mockFetch(() => image())
    const seed = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      generation(instance),
    )
    const saved = await waitRecord(instance, seed.record.id)
    const response = deferred<Response>()
    let calls = 0
    mockFetch(() => {
      calls += 1
      return calls === 1 ? response.promise : image()
    })
    const active = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      generation(instance),
    )
    await vi.waitFor(() => expect(calls).toBe(1))
    let nextId = ''
    try {
      await instance.store.mutate((document) => {
        document.records = [
          ...Array.from({ length: MAX_RECORDS - 1 }, (_, index) => ({
            ...saved,
            id: `archive-${index}`,
          })),
          document.records.find((record) => record.id === active.record.id)!,
        ]
      })
      const next = await instance.call<{ record: GenerationRecord }>(
        'image.generate',
        generation(instance),
      )
      nextId = next.record.id
      await vi.waitFor(async () => {
        const read = await instance.call<{ record: GenerationRecord }>(
          'image.records.get',
          { id: nextId },
        )
        expect(read.record.status).toBe('success')
      })
      const document = await instance.store.read()
      expect(document.records).toHaveLength(MAX_RECORDS)
      expect(
        document.records.find((record) => record.id === active.record.id)?.status,
      ).toBe('running')
      expect(
        document.records.some((record) => record.id === `archive-${MAX_RECORDS - 2}`),
      ).toBe(false)
      expect((await instance.images.readAll(saved.outputs[0]!.id)).bytes).toEqual(
        new Uint8Array(PNG),
      )
    } finally {
      response.resolve(image())
    }
    await waitRecord(instance, active.record.id)
    expect((await waitRecord(instance, nextId)).status).toBe('success')
  })
})
