import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiImage, AI_IMAGE_METHODS } from './ai-image.js'
import type { GenerationRecord, ProviderView } from '../domain/types.js'
import { createMemoryImageStore } from '../store/image-files.js'
import { createMemoryStore } from '../store/private-store.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1cAAAAASUVORK5CYII=',
  'base64',
)
const MODEL = 'gpt-image-2.5-flare'
const INPUT = {
  model: MODEL,
  mode: 'generate',
  prompt: 'A used blue mug on a wooden table.',
  size: '1024x1024',
  inputFileIds: [],
}
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const image = () => json({ data: [{ b64_json: PNG.toString('base64') }] })

function setup(store = createMemoryStore(), files = createMemoryImageStore()) {
  const plugin = new AiImage({
    store,
    images: files,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    idFactory: randomUUID,
  })
  const call = <T = { record: GenerationRecord }>(
    method: string,
    payload: unknown = {},
  ) =>
    plugin.call({
      requestId: randomUUID(),
      capability: 'image.provider',
      method,
      payload,
      deadlineAt: Date.now() + 5000,
      assertAlive: () => undefined,
    }) as Promise<T>
  return { plugin, store, files, call }
}

async function configured() {
  const instance = setup()
  const provider = await instance.call<ProviderView>('image.providers.save', {
    name: 'Image-only gateway',
    kind: 'openai_compatible',
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'synthetic-provider-test',
    imageModel: MODEL,
    visionModel: '',
  })
  await instance.files.write('reference', 'image/png', PNG)
  return { ...instance, provider }
}

async function idle(instance: ReturnType<typeof setup>) {
  await vi.waitFor(() => expect(instance.plugin.status()['running']).toBe(0))
  return instance.store.read()
}

afterEach(() => vi.unstubAllGlobals())

describe('actual provider image testing', () => {
  it('advertises a dedicated test that makes one real generation request and stores its result', async () => {
    const instance = await configured()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(image())
    vi.stubGlobal('fetch', fetch)
    expect(AI_IMAGE_METHODS).toContain('image.providers.testImage')
    const accepted = await instance.call('image.providers.testImage', {
      ...INPUT,
      id: instance.provider.id,
    })
    expect(accepted.record).toMatchObject({
      purpose: 'provider-test',
      status: 'running',
      count: 1,
      providerId: instance.provider.id,
      imageModel: MODEL,
      vision: null,
    })
    const document = await idle(instance)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/images/generations')
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      model: MODEL,
      prompt: INPUT.prompt,
      n: 1,
      size: INPUT.size,
    })
    expect(document.records[0]).toMatchObject({
      id: accepted.record.id,
      purpose: 'provider-test',
      status: 'success',
      title: '测试生图',
    })
    expect(document.records[0]?.outputs).toHaveLength(1)
    expect(document.selections).toEqual({ image: null, vision: null })
    const listed = await instance.call<{ items: { purpose?: string }[] }>(
      'image.records.list',
      { page: 0, size: 10 },
    )
    expect(listed.items[0]?.purpose).toBe('provider-test')
  })

  it('tests a reference directly against the edit endpoint without requiring or calling vision', async () => {
    const instance = await configured()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(image())
    vi.stubGlobal('fetch', fetch)
    await instance.call('image.providers.testImage', {
      ...INPUT,
      id: instance.provider.id,
      mode: 'edit',
      inputFileIds: ['reference'],
    })
    const document = await idle(instance)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/images/edits')
    const form = fetch.mock.calls[0]?.[1]?.body as FormData
    expect(form.get('model')).toBe(MODEL)
    expect(form.get('n')).toBe('1')
    expect(form.getAll('image[]')).toHaveLength(1)
    const file = form.get('image[]') as File
    expect(file.type).toBe('image/png')
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG)
    expect(document.records[0]).toMatchObject({
      status: 'success',
      mode: 'edit',
      vision: null,
      title: '测试图生图',
    })
  })

  it.each([
    { model: '' },
    { model: 'another-model' },
    { prompt: '  ' },
    { count: 4 },
    { inputFileIds: ['reference'] },
    { mode: 'edit', inputFileIds: [] },
    { mode: 'edit', inputFileIds: ['reference', 'reference'] },
    { mode: 'edit', inputFileIds: ['missing'] },
  ])(
    'rejects invalid or stale test input before issuing a paid request: %j',
    async (change) => {
      const instance = await configured()
      const fetch = vi.fn<typeof globalThis.fetch>()
      vi.stubGlobal('fetch', fetch)
      await expect(
        instance.call('image.providers.testImage', {
          ...INPUT,
          id: instance.provider.id,
          ...change,
        }),
      ).rejects.toThrow()
      expect(fetch).not.toHaveBeenCalled()
      expect((await instance.store.read()).records).toEqual([])
    },
  )

  it('does not turn a passing model-list check into a successful image test', async () => {
    const instance = await configured()
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) =>
      String(url).endsWith('/models')
        ? json({ data: [{ id: MODEL }] })
        : json(
            {
              error: {
                message: `No available channel for model ${MODEL} under group default (distributor) (request id: synthetic-request)`,
              },
            },
            503,
          ),
    )
    vi.stubGlobal('fetch', fetch)
    const check = await instance.call<{ ok: boolean }>('image.providers.test', {
      id: instance.provider.id,
    })
    expect(check.ok).toBe(true)
    await instance.call('image.providers.testImage', {
      ...INPUT,
      id: instance.provider.id,
    })
    const document = await idle(instance)
    expect(document.records[0]).toMatchObject({ status: 'failed', outputs: [] })
    expect(document.records[0]?.error).toContain('通道')
    expect(document.records[0]?.error).toContain('synthetic-request')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('returns a tracked job immediately and blocks duplicate active tests for the same provider', async () => {
    const instance = await configured()
    let finish!: (value: Response) => void
    const response = new Promise<Response>((resolve) => {
      finish = resolve
    })
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(response)
    vi.stubGlobal('fetch', fetch)
    const accepted = await instance.call('image.providers.testImage', {
      ...INPUT,
      id: instance.provider.id,
    })
    expect(accepted.record.status).toBe('running')
    try {
      await expect(
        instance.call('image.providers.testImage', {
          ...INPUT,
          id: instance.provider.id,
        }),
      ).rejects.toThrow('测试')
      expect((await instance.store.read()).records).toHaveLength(1)
    } finally {
      finish(image())
      await idle(instance)
    }
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not report a successful single-image test when the provider returns multiple images', async () => {
    const instance = await configured()
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        json({
          data: [
            { b64_json: PNG.toString('base64') },
            { b64_json: PNG.toString('base64') },
          ],
        }),
      ),
    )
    await instance.call('image.providers.testImage', {
      ...INPUT,
      id: instance.provider.id,
    })
    const document = await idle(instance)
    expect(document.records[0]).toMatchObject({ status: 'failed', outputs: [] })
  })

  it('preserves the tested model on a manual retry and does not replace production preferences', async () => {
    const instance = await configured()
    await instance.store.mutate((doc) => {
      doc.selections.image = { providerId: instance.provider.id, model: MODEL }
    })
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({ error: { message: 'Temporary provider failure' } }, 503),
      )
      .mockResolvedValueOnce(image())
    vi.stubGlobal('fetch', fetch)
    const { record } = await instance.call('image.providers.testImage', {
      ...INPUT,
      id: instance.provider.id,
    })
    await idle(instance)
    await instance.call('image.providers.save', {
      id: instance.provider.id,
      name: 'Updated gateway',
      kind: 'openai_compatible',
      baseUrl: 'https://gateway.example/v1',
      imageModel: 'changed-model',
      visionModel: '',
    })
    await instance.call('image.records.retry', { id: record.id })
    const document = await idle(instance)
    expect(document.records[0]).toMatchObject({
      purpose: 'provider-test',
      imageModel: MODEL,
      status: 'success',
    })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).model).toBe(MODEL)
    expect(document.selections.image).toEqual({
      providerId: instance.provider.id,
      model: MODEL,
    })
  })

  it('recovers an interrupted test on restart without automatically sending another request', async () => {
    const instance = await configured()
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(image()))
    const { record } = await instance.call('image.providers.testImage', {
      ...INPUT,
      id: instance.provider.id,
    })
    await idle(instance)
    await instance.store.mutate((doc) => {
      Object.assign(doc.records[0]!, {
        status: 'running',
        stage: 'image',
        outputs: [],
        error: null,
      })
    })
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetch)
    const restarted = setup(instance.store, instance.files)
    const recovered = await restarted.call('image.records.get', { id: record.id })
    expect(recovered.record).toMatchObject({
      purpose: 'provider-test',
      status: 'failed',
      stage: 'done',
    })
    expect(recovered.record.error).toContain('中断')
    expect(fetch).not.toHaveBeenCalled()
  })
})
