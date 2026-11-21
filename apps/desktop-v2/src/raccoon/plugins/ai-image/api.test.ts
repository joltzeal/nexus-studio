import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callPlugin } from '../call'
import {
  forgetImage,
  generate,
  getRecord,
  imageObjectUrl,
  listProviders,
  listRecords,
  readImageBytes,
  uploadImage,
  type GenerateInput,
} from './api'
import { CHUNK_BYTES, MAX_IMAGE_BYTES, parseRecord } from './parse'
import { makePlan, makeProvider, makeSceneRecord } from './scene-plan.test-data'
import { parseScenePlan } from './scene-plan'
import { AI_METHODS, supportsAiFeature, supportsAiPage } from './page-contract'

const rpc = vi.hoisted(() =>
  vi.fn<(method: string, payload: unknown) => Promise<unknown>>(),
)
vi.mock('../call', () => ({
  callPlugin: vi.fn(
    async <T>(
      _id: string,
      _capability: string,
      method: string,
      payload: unknown,
      parse: (value: unknown) => T,
    ) => parse(await rpc(method, payload)),
  ),
}))

function encode(bytes: Uint8Array) {
  let value = ''
  for (let offset = 0; offset < bytes.length; offset += 8192)
    value += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(value)
}

beforeEach(() => rpc.mockReset())
afterEach(() => vi.restoreAllMocks())

describe('v2 AI image boundary', () => {
  it('uses the v2 parser argument and rejects secret-bearing providers', async () => {
    const catalog = {
      items: [makeProvider()],
      storageDurable: true,
      modelConfigVersion: 2,
      transportSettingsVersion: 1,
      selections: { image: null, vision: null },
    }
    rpc.mockResolvedValue(catalog)
    expect(await listProviders()).toEqual(catalog)
    expect(callPlugin).toHaveBeenLastCalledWith(
      'studio.ai-image',
      'image.provider',
      'image.providers.list',
      {},
      expect.any(Function),
      30_000,
    )
    rpc.mockResolvedValue({
      ...catalog,
      items: [{ ...makeProvider(), apiKey: 'secret' }],
    })
    await expect(listProviders()).rejects.toThrow()
    rpc.mockResolvedValue({
      ...catalog,
      items: [{ ...makeProvider(), imageTimeoutSeconds: 3601 }],
    })
    await expect(listProviders()).rejects.toThrow()
  })

  it('preserves full stored and edited prompts, translations, exports, and historical fields', async () => {
    const record = makeSceneRecord()
    record.prompt = `  ${'Keep every constraint.\n'.repeat(3000)}  `
    record.basePrompt = 'Original requirements\nwith untouched spacing.  '
    record.userRequirements = '用户商品约束'
    record.exportedPaths = ['/Downloads/Nexus AI/IMG_1234.jpg']
    record.exportError = 'Disk is full'
    record.vision = {
      providerId: 'vision-provider',
      providerName: 'Vision',
      providerKind: 'openai',
      model: 'vision-model',
      inputFileId: 'reference',
      title: null,
      description: null,
      translatedRequirements: 'Preserve the original colors and text.',
    }
    if (!record.scenePlan?.plan.result) throw new Error('fixture')
    record.scenePlan.plan.result.translatedRequirements = 'Do not add a frame.'
    record.scenePlan.views[0]!.effectivePrompt = record.prompt
    rpc.mockResolvedValue({ record })
    const read = (await getRecord(record.id)).record
    expect(read).toEqual(record)
    expect(read.prompt.length).toBeGreaterThan(12000)
    expect(read.scenePlan?.views[0]?.effectivePrompt).toBe(record.prompt)
    expect(parseScenePlan(record.scenePlan.plan).result?.translatedRequirements).toBe(
      'Do not add a frame.',
    )
  })

  it('rejects incomplete records, mixed identities, and malformed summary pagination', async () => {
    for (const value of [
      null,
      { id: 'record' },
      { ...makeSceneRecord(), outputs: [{}] },
      { ...makeSceneRecord(), vision: { inputFileId: 'missing' } },
    ]) {
      expect(() => parseRecord(value)).toThrow()
    }
    rpc.mockResolvedValue({ record: makeSceneRecord() })
    await expect(getRecord('different')).rejects.toThrow('其他生成记录')
    rpc.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
      storageDurable: true,
    })
    await expect(listRecords(0, 10)).rejects.toThrow()
    expect(() => parseScenePlan({ ...makePlan(), result: { views: [] } })).toThrow()
  })

  it('sends the full user prompt once and verifies the accepted task binding', async () => {
    const input: GenerateInput = {
      providerId: 'image-provider',
      imageModel: 'image-model',
      mode: 'generate',
      count: 1,
      size: 'auto',
      presetId: null,
      prompt: `  ${'Preserve the printed text.\n'.repeat(400)}  `,
      inputFileIds: [],
    }
    const record = {
      ...makeSceneRecord(),
      mode: 'generate',
      count: 1,
      inputs: [],
      outputs: [],
      scenePlan: undefined,
    }
    rpc.mockResolvedValue({ record })
    await generate(input)
    expect(rpc).toHaveBeenCalledExactlyOnceWith('image.generate', input)
    expect(vi.mocked(callPlugin).mock.lastCall?.[3]).toEqual(input)
    rpc.mockClear()
    await expect(generate({ ...input, prompt: 'x'.repeat(12001) })).rejects.toThrow()
    expect(rpc).not.toHaveBeenCalled()
    rpc.mockResolvedValue({ record: { ...record, providerId: 'unexpected-provider' } })
    await expect(generate(input)).rejects.toThrow('勿重复提交')
    rpc.mockResolvedValue({ record: { id: 'accepted-with-incomplete-response' } })
    await expect(generate(input)).rejects.toThrow('勿重复提交')
  })

  it('gates each optional group without making it a base dependency', () => {
    const plugin = {
      enabled: true,
      state: 'running',
      capabilities: ['image.provider'],
      granted: ['image.provider'],
      methods: [...AI_METHODS.base] as string[],
    }
    expect(supportsAiPage(plugin)).toBe(true)
    for (const feature of ['plans', 'testImage', 'remote', 'export'] as const) {
      expect(supportsAiFeature(plugin, feature)).toBe(false)
      expect(
        supportsAiFeature(
          { ...plugin, methods: [...plugin.methods, ...AI_METHODS[feature]] },
          feature,
        ),
      ).toBe(true)
    }
    for (const method of AI_METHODS.base)
      expect(
        supportsAiPage({
          ...plugin,
          methods: plugin.methods.filter((entry) => entry !== method),
        }),
      ).toBe(false)
    expect(supportsAiPage({ ...plugin, granted: [] })).toBe(false)
    expect(supportsAiPage({ ...plugin, state: 'starting' })).toBe(false)
    expect(supportsAiPage({ ...plugin, enabled: false })).toBe(false)
  })
})

describe('bounded file transfers', () => {
  it('assembles exactly the declared bytes across chunks', async () => {
    const bytes = new Uint8Array(CHUNK_BYTES + 3)
    bytes.set([1, 2, 3], CHUNK_BYTES)
    rpc
      .mockResolvedValueOnce({
        data: encode(bytes.subarray(0, CHUNK_BYTES)),
        next: CHUNK_BYTES,
        total: bytes.length,
        done: false,
      })
      .mockResolvedValueOnce({
        data: encode(bytes.subarray(CHUNK_BYTES)),
        next: bytes.length,
        total: bytes.length,
        done: true,
      })
    expect(await readImageBytes('image')).toEqual(bytes)
    expect(rpc).toHaveBeenNthCalledWith(2, 'image.file.chunk', {
      fileId: 'image',
      offset: CHUNK_BYTES,
      length: CHUNK_BYTES,
    })
  })

  it.each([
    { data: '', next: 0, total: 3, done: false },
    { data: 'AQID', next: 0, total: 3, done: true },
    { data: 'AQID', next: 3, total: 3, done: false },
    { data: 'AQID', next: 3, total: 4, done: true },
    { data: 'AQID', next: 4, total: 4, done: true },
    { data: 'AQI=', next: 2, total: 3, done: true },
    { data: 'AQI?', next: 3, total: 3, done: true },
    { data: 'AB==', next: 1, total: 1, done: true },
    { data: 'AQID', next: 3, total: MAX_IMAGE_BYTES + 1, done: false },
  ])(
    'rejects invalid progress, completeness, total or canonical base64 %#',
    async (reply) => {
      rpc.mockResolvedValue(reply)
      await expect(readImageBytes('image')).rejects.toThrow()
      expect(rpc).toHaveBeenCalledTimes(1)
    },
  )

  it('rejects a changed total and stops before another request after cancellation', async () => {
    const chunk = {
      data: encode(new Uint8Array(CHUNK_BYTES)),
      next: CHUNK_BYTES,
      total: CHUNK_BYTES + 1,
      done: false,
    }
    rpc.mockResolvedValueOnce(chunk).mockResolvedValueOnce({
      data: 'AQI=',
      next: CHUNK_BYTES + 2,
      total: CHUNK_BYTES + 2,
      done: true,
    })
    await expect(readImageBytes('image')).rejects.toThrow('大小发生变化')
    rpc.mockReset()
    const controller = new AbortController()
    rpc.mockImplementation(async () => {
      controller.abort()
      return chunk
    })
    await expect(readImageBytes('image', controller.signal)).rejects.toThrow()
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('cancels pending cache reads and revokes completed URLs when forgotten', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    rpc.mockImplementation(async () => {
      await Promise.resolve()
      forgetImage('pending')
      return { data: 'AQID', next: 3, total: 3, done: true }
    })
    await expect(imageObjectUrl('pending', 'image/png')).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
    rpc.mockResolvedValue({ data: 'AQID', next: 3, total: 3, done: true })
    expect(await imageObjectUrl('ready', 'image/png')).toBe('blob:test')
    forgetImage('ready')
    await Promise.resolve()
    expect(revoke).toHaveBeenCalledWith('blob:test')
  })

  it('checks upload acknowledgement and aborts mismatched or cancelled sessions', async () => {
    const controller = new AbortController()
    rpc.mockImplementation(async (method) => {
      if (method === 'image.upload.begin') {
        controller.abort()
        return { uploadId: 'upload', chunkSize: 4 }
      }
      return { aborted: true }
    })
    await expect(
      uploadImage(
        new File(['bytes'], 'test.png', { type: 'image/png' }),
        controller.signal,
      ),
    ).rejects.toThrow()
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      'image.upload.begin',
      'image.upload.abort',
    ])
    rpc.mockReset()
    rpc.mockImplementation(async (method) => {
      if (method === 'image.upload.begin') return { uploadId: 'upload', chunkSize: 4 }
      if (method === 'image.upload.chunk')
        return { uploadId: 'upload', received: 1, size: 5 }
      return { aborted: true }
    })
    await expect(
      uploadImage(new File(['bytes'], 'test.png', { type: 'image/png' })),
    ).rejects.toThrow()
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      'image.upload.begin',
      'image.upload.chunk',
      'image.upload.abort',
    ])
  })
})
