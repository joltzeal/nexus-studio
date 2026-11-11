import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiImage } from './ai-image.js'
import { unavailable } from '../domain/errors.js'
import type {
  GenerationRecord,
  GenerationSummary,
  ProviderView,
  ScenePlan,
} from '../domain/types.js'
import { createMemoryImageStore } from '../store/image-files.js'
import {
  createFileStore,
  createMemoryStore,
  type PrivateStore,
} from '../store/private-store.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const SOURCE = {
  pluginId: 'studio.vinted-monitor',
  itemId: 'vinted.fr:queue-test',
  title: 'Source title for batch retrieval',
  url: 'https://vinted.fr/items/queue-test',
}
const directories: string[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function image(count = 1, status = 200) {
  return new Response(
    JSON.stringify(
      status === 200
        ? {
            data: Array.from({ length: count }, () => ({
              b64_json: PNG.toString('base64'),
            })),
          }
        : { error: { message: 'controlled image failure' } },
    ),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

function setup(store: PrivateStore = createMemoryStore()) {
  const plugin = new AiImage({
    store,
    images: createMemoryImageStore(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
  return { plugin, store, call }
}

async function provider(instance: ReturnType<typeof setup>) {
  return instance.call<ProviderView>('image.providers.save', {
    name: 'Mock image provider',
    kind: 'openai_compatible',
    baseUrl: 'https://queue.example.invalid/v1',
    apiKey: 'test-only-key',
    imageModel: 'original-image-model',
  })
}

function payload(saved: ProviderView, prompt = 'Batch one', count = 3) {
  return {
    providerId: saved.id,
    imageModel: saved.imageModel,
    mode: 'generate',
    presetId: null,
    prompt,
    size: 'auto',
    count,
    inputFileIds: [],
    source: { ...SOURCE },
  }
}

function record(overrides: Partial<GenerationRecord> = {}): GenerationRecord {
  return {
    id: randomUUID(),
    createdAt: '2026-11-11T12:00:00.000Z',
    updatedAt: '2026-11-11T12:00:00.000Z',
    status: 'success',
    stage: 'done',
    mode: 'generate',
    prompt: 'Ordinary image prompt',
    presetId: null,
    presetLabel: null,
    size: 'auto',
    count: 1,
    providerId: 'image-provider',
    providerName: 'Mock provider',
    providerKind: 'openai_compatible',
    imageModel: 'image-model',
    vision: null,
    outputVision: null,
    inputs: [],
    outputs: [],
    title: null,
    description: null,
    error: null,
    durationMs: 100,
    ...overrides,
  }
}

function sceneRecord(overrides: Partial<GenerationRecord> = {}): GenerationRecord {
  const plan: ScenePlan = {
    id: 'original-scene-plan',
    createdAt: '2026-11-11T12:00:00.000Z',
    updatedAt: '2026-11-11T12:00:00.000Z',
    status: 'success',
    providerId: 'vision-provider',
    providerName: 'Mock vision provider',
    providerKind: 'openai_compatible',
    model: 'vision-model',
    inputFileId: 'reference',
    requirements: 'Keep the worn corners.',
    count: 3,
    error: null,
    result: {
      title: 'Decorative sign',
      description: 'Original sign with worn corners.',
      product: 'Decorative sign',
      material: 'Unknown',
      observations: 'Visible front lettering.',
      uncertainties: 'The back is not visible.',
      presetId: 'home-sofa',
      reason: 'A modest living room suits the product.',
      prompt: 'Show the original sign in a modest living room.',
      views: ['Front', 'Room', 'Detail'].map((label) => ({
        id: label.toLowerCase(),
        label,
        prompt: `Show the ${label.toLowerCase()} of the original sign.`,
      })),
    },
  }
  return record({
    id: 'scene-submission-one',
    mode: 'edit',
    count: 3,
    status: 'failed',
    source: { ...SOURCE },
    inputs: [{ id: 'reference', mime: 'image/png', name: 'reference.png', bytes: 9 }],
    scenePlan: {
      plan,
      prompt: plan.result!.prompt,
      views: plan.result!.views.map((view) => ({
        ...view,
        status: 'failed',
        outputFileId: null,
        error: 'Controlled failure',
        effectivePrompt: view.prompt,
      })),
    },
    ...overrides,
  })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('generation queue', () => {
  it('persists complete submission parents, bounds workers, and queues manual retry behind waiting batches', async () => {
    const instance = setup()
    const saved = await provider(instance)
    const gates = Array.from({ length: 5 }, () => deferred<Response>())
    const requests: { prompt: string; model: string; n: number }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)) as (typeof requests)[number])
        return gates[requests.length - 1]!.promise
      }),
    )
    try {
      const submitted: GenerationRecord[] = []
      for (let index = 1; index <= 4; index += 1) {
        const result = await instance.call<{ record: GenerationRecord }>(
          'image.generate',
          payload(saved, `Batch ${index}`),
        )
        submitted.push(result.record)
      }
      await vi.waitFor(() => expect(requests).toHaveLength(2))
      const queued = await instance.call<{ record: GenerationRecord }>(
        'image.records.get',
        { id: submitted[2]!.id },
      )
      expect(queued.record).toMatchObject({
        id: submitted[2]!.id,
        status: 'running',
        stage: 'queued',
        count: 3,
        source: SOURCE,
      })
      expect(instance.plugin.status()).toMatchObject({ queued: 2, activeGenerations: 2 })
      expect((await instance.store.read()).records).toHaveLength(4)
      await expect(
        instance.call('image.records.retry', { id: queued.record.id }),
      ).rejects.toThrow()
      await expect(
        instance.call('image.records.remove', { id: queued.record.id }),
      ).rejects.toThrow()

      gates[0]!.resolve(image(1, 500))
      await vi.waitFor(() => expect(requests).toHaveLength(3))
      expect(requests[2]!.prompt).toContain('Batch 3')
      const retry = await instance.call<{ record: GenerationRecord }>(
        'image.records.retry',
        { id: submitted[0]!.id },
      )
      expect(retry.record).toMatchObject({
        id: submitted[0]!.id,
        source: SOURCE,
        count: 3,
        stage: 'queued',
      })
      expect(requests).toHaveLength(3)
      gates[1]!.resolve(image(3))
      await vi.waitFor(() => expect(requests).toHaveLength(4))
      expect(requests[3]!.prompt).toContain('Batch 4')
      gates[2]!.resolve(image(3))
      await vi.waitFor(() => expect(requests).toHaveLength(5))
      expect(requests[4]!.prompt).toContain('Batch 1')
      gates[3]!.resolve(image(3))
      gates[4]!.resolve(image(3))
      await vi.waitFor(() => expect(instance.plugin.status()['running']).toBe(0))
      const completed = await instance.store.read()
      expect(completed.records).toHaveLength(4)
      expect(
        completed.records.every(
          (entry) =>
            entry.status === 'success' &&
            entry.outputs.length === 3 &&
            entry.source?.itemId === SOURCE.itemId,
        ),
      ).toBe(true)
      expect(
        requests.every(
          (request) =>
            request.model === 'original-image-model' &&
            request.n === 3 &&
            !request.prompt.includes(SOURCE.title),
        ),
      ).toBe(true)
    } finally {
      for (const gate of gates) gate.resolve(image(3))
      await vi.waitFor(() => expect(instance.plugin.status()['running']).toBe(0))
    }
  })

  it('does not dispatch or retain a queue reservation when parent persistence fails', async () => {
    const memory = createMemoryStore()
    let rejectNext = false
    const store: PrivateStore = {
      kind: memory.kind,
      durable: memory.durable,
      read: () => memory.read(),
      mutate: (apply) =>
        memory.mutate(async (document) => {
          const result = await apply(document)
          if (rejectNext) {
            rejectNext = false
            throw unavailable('Controlled persistence failure')
          }
          return result
        }),
    }
    const instance = setup(store)
    const saved = await provider(instance)
    const fetch = vi.fn(() => image(3))
    vi.stubGlobal('fetch', fetch)
    rejectNext = true
    await expect(instance.call('image.generate', payload(saved))).rejects.toThrow(
      'persistence failure',
    )
    expect((await store.read()).records).toEqual([])
    expect(instance.plugin.status()['running']).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
    await instance.call('image.generate', payload(saved))
    await vi.waitFor(() => expect(instance.plugin.status()['running']).toBe(0))
    expect((await store.read()).records[0]?.status).toBe('success')
  })

  it('recovers queued and active ordinary batches durably without replaying paid requests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-ai-queue-'))
    directories.push(directory)
    const first = record({
      id: 'waiting-batch',
      status: 'running',
      stage: 'queued',
      count: 4,
      source: SOURCE,
    })
    const second = record({
      id: 'active-batch',
      status: 'running',
      stage: 'image',
      source: SOURCE,
    })
    const completed = record({ id: 'completed' })
    await createFileStore(directory).mutate((document) => {
      document.records = [first, second, completed]
    })
    const restarted = setup(createFileStore(directory))
    const fetch = vi.fn(() => {
      throw new Error('Recovery must not send a request')
    })
    vi.stubGlobal('fetch', fetch)
    const listed = await restarted.call<{ items: GenerationSummary[] }>(
      'image.records.list',
      { page: 0, size: 10 },
    )
    expect(listed.items.map((entry) => [entry.id, entry.status, entry.stage])).toEqual([
      ['waiting-batch', 'failed', 'done'],
      ['active-batch', 'failed', 'done'],
      ['completed', 'success', 'done'],
    ])
    const durable = (await createFileStore(directory).read()).records
    expect(durable[0]).toMatchObject({ id: first.id, source: SOURCE, count: 4 })
    expect(durable[0]?.error).toContain('中断')
    expect(durable[1]?.error).toContain('中断')
    expect(durable[2]).toEqual(completed)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('batch history search', () => {
  it('searches complete persisted source/view text before paginating whole submission parents', async () => {
    const instance = setup()
    const first = sceneRecord()
    first.source!.title = `${'Long source preview '.repeat(20)} Cabinet`
    first.scenePlan!.views[0]!.label = 'Needle front'
    const second = structuredClone(first)
    second.id = 'scene-submission-two'
    second.createdAt = '2026-11-11T13:00:00.000Z'
    await instance.store.mutate((document) => {
      document.records = [
        record({ source: SOURCE }),
        first,
        second,
        sceneRecord({ id: 'other-source', source: { ...SOURCE, itemId: 'different' } }),
      ]
    })
    const filters = {
      query: 'cabinet NEEDLE',
      kind: 'scene',
      status: 'failed',
      sourcePluginId: SOURCE.pluginId,
      sourceItemId: SOURCE.itemId,
    }
    for (const [page, id] of [
      [0, second.id],
      [1, first.id],
    ] as const) {
      const result = await instance.call<{
        items: GenerationSummary[]
        total: number
        historyFilters: unknown
      }>('image.records.list', { page, size: 1, ...filters })
      expect(result.total).toBe(2)
      expect(result.items.map((entry) => entry.id)).toEqual([id])
      expect(result.items[0]?.scenePlan?.views).toHaveLength(3)
      expect(result.historyFilters).toEqual({ query: 'cabinet NEEDLE', kind: 'scene' })
    }
    const byPlan = await instance.call<{ total: number }>('image.records.list', {
      page: 0,
      size: 10,
      query: 'original-scene-plan',
      sourcePluginId: SOURCE.pluginId,
      sourceItemId: SOURCE.itemId,
    })
    expect(byPlan.total).toBe(2)
    expect(
      (await instance.store.read()).records.find((entry) => entry.id === first.id),
    ).toEqual(first)
  })

  it('keeps standalone records available and filters ordinary multi-image batches separately from scenes and tests', async () => {
    const instance = setup()
    const ordinary = record({ id: 'multi-image-parent', count: 4 })
    await instance.store.mutate((document) => {
      document.records = [
        ordinary,
        record({ id: 'standalone' }),
        sceneRecord(),
        record({ id: 'provider-test', purpose: 'provider-test' }),
      ]
    })
    for (const [kind, id] of [
      ['batch', 'multi-image-parent'],
      ['single', 'standalone'],
      ['scene', 'scene-submission-one'],
      ['provider-test', 'provider-test'],
    ]) {
      const result = await instance.call<{ items: GenerationSummary[]; total: number }>(
        'image.records.list',
        { page: 0, size: 10, kind },
      )
      expect(result.total).toBe(1)
      expect(result.items.map((entry) => entry.id)).toEqual([id])
    }
    await expect(
      instance.call('image.records.list', { page: 0, size: 10, query: 'x'.repeat(201) }),
    ).rejects.toThrow()
    await expect(
      instance.call('image.records.list', { page: 0, size: 10, kind: 'invented' }),
    ).rejects.toThrow()
  })
})
