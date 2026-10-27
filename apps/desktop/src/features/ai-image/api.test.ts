import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callPlugin } from '@/lib/platform/native-plugins'
import {
  generate,
  listProviders,
  listRecords,
  saveProvider,
  testProviderImage,
  uploadImage,
  type GenerateInput,
  type ProviderImageTestInput,
} from './api'
import { makeProvider } from './scene-plan.test-data'
import { SOURCE_UPDATE_HINT } from './source'
import type { GenerationRecord, GenerationSource, RecordPage } from './types'

vi.mock('@/lib/platform/native-plugins', () => ({ callPlugin: vi.fn() }))

const source: GenerationSource = {
  pluginId: 'studio.vinted-monitor',
  itemId: 'vinted.fr:123',
  title: 'Used mug',
  url: 'https://www.vinted.fr/items/123',
}
const sourceFilter = { sourcePluginId: source.pluginId, sourceItemId: source.itemId }
const input: GenerateInput = {
  providerId: 'provider',
  imageModel: 'image-model',
  visionProviderId: 'vision-provider',
  visionModel: 'vision-model',
  mode: 'edit',
  presetId: null,
  prompt: 'An editable product description',
  size: 'auto',
  count: 1,
  inputFileIds: ['image'],
}
const page: RecordPage = {
  items: [],
  page: 0,
  pageSize: 10,
  total: 0,
  storageDurable: true,
  sourceFilter,
}

beforeEach(() => {
  vi.mocked(callPlugin).mockReset()
})

describe('provider transport capability', () => {
  const saved = {
    ...makeProvider(),
    imageTimeoutSeconds: 1800,
    imageResponseMode: 'stream',
  }
  const catalog = {
    items: [saved],
    storageDurable: true,
    modelConfigVersion: 2,
    transportSettingsVersion: 1,
    selections: { image: null, vision: null },
  }
  const input = {
    name: 'Gateway',
    kind: 'openai_compatible' as const,
    baseUrl: 'https://gateway.example/v1',
    imageModel: 'exact-image-model',
    imageTimeoutSeconds: 1800,
    imageResponseMode: 'stream' as const,
  }

  it('preserves the independent capability marker and saved settings when normalizing a catalog', async () => {
    vi.mocked(callPlugin).mockResolvedValue(catalog)
    expect(await listProviders()).toEqual(catalog)
  })

  it.each([undefined, 0, 2])(
    'defaults legacy display fields without claiming support for version %s',
    async (version) => {
      vi.mocked(callPlugin).mockResolvedValue({
        ...catalog,
        transportSettingsVersion: version,
        items: [
          {
            ...saved,
            imageTimeoutSeconds: undefined,
            imageResponseMode: undefined,
          },
        ],
      })
      expect(await listProviders()).toMatchObject({
        modelConfigVersion: 2,
        transportSettingsVersion: 0,
        items: [{ imageTimeoutSeconds: 900, imageResponseMode: 'auto' }],
      })
    },
  )

  it.each([undefined, 0, 2])(
    'blocks new fields before saving to transport version %s, without dropping them or retrying',
    async (version) => {
      vi.mocked(callPlugin).mockResolvedValue({
        ...catalog,
        transportSettingsVersion: version,
      })
      await expect(saveProvider(input)).rejects.toThrow('更新 AI 生图插件')
      expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
        'studio.ai-image',
        'image.provider',
        'image.providers.list',
        {},
        30000,
      )
    },
  )

  it('saves exact seconds and mode after a fresh read-only compatibility check', async () => {
    vi.mocked(callPlugin).mockResolvedValueOnce(catalog).mockResolvedValueOnce(saved)
    expect(await saveProvider(input)).toEqual(saved)
    expect(callPlugin).toHaveBeenNthCalledWith(
      2,
      'studio.ai-image',
      'image.provider',
      'image.providers.save',
      input,
      30000,
    )
    vi.mocked(callPlugin).mockResolvedValueOnce({
      ...catalog,
      transportSettingsVersion: undefined,
    })
    await expect(saveProvider(input)).rejects.toThrow('更新 AI 生图插件')
    expect(callPlugin).toHaveBeenCalledTimes(3)
  })

  it('checks support even when just one setting is supplied', async () => {
    vi.mocked(callPlugin).mockResolvedValue({ ...catalog, transportSettingsVersion: 0 })
    await expect(
      saveProvider({ ...input, imageResponseMode: undefined }),
    ).rejects.toThrow('更新 AI 生图插件')
    await expect(
      saveProvider({ ...input, imageTimeoutSeconds: undefined }),
    ).rejects.toThrow('更新 AI 生图插件')
    expect(vi.mocked(callPlugin).mock.calls.map((call) => call[2])).toEqual([
      'image.providers.list',
      'image.providers.list',
    ])
  })

  it('retains an old caller edit without inventing or overwriting optional settings', async () => {
    const legacyEdit = {
      id: 'saved-id',
      name: input.name,
      kind: input.kind,
      baseUrl: input.baseUrl,
      imageModel: input.imageModel,
    }
    vi.mocked(callPlugin).mockResolvedValue(saved)
    await saveProvider(legacyEdit)
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.ai-image',
      'image.provider',
      'image.providers.save',
      legacyEdit,
      30000,
    )
  })

  it('reports a failed capability check without attempting a save', async () => {
    vi.mocked(callPlugin).mockRejectedValue(new Error('Plugin disconnected'))
    await expect(saveProvider(input)).rejects.toThrow('Plugin disconnected')
    expect(callPlugin).toHaveBeenCalledTimes(1)
    expect(vi.mocked(callPlugin).mock.calls[0]?.[2]).toBe('image.providers.list')
  })
})

describe('source API', () => {
  it('lists with the identity pair only, before pagination is interpreted by the caller', async () => {
    vi.mocked(callPlugin).mockResolvedValue(page)
    expect(await listRecords(2, 10, 'failed', source)).toEqual(page)
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.ai-image',
      'image.provider',
      'image.records.list',
      { page: 2, size: 10, status: 'failed', ...sourceFilter },
      30000,
    )
    const sent = JSON.stringify(vi.mocked(callPlugin).mock.calls)
    expect(sent).not.toContain(source.title)
    expect(sent).not.toContain(source.url)
  })

  it('refuses incomplete identity at runtime before any RPC', async () => {
    await expect(
      listRecords(0, 10, undefined, { pluginId: source.pluginId, itemId: '' }),
    ).rejects.toThrow('商品来源信息无效')
    expect(callPlugin).not.toHaveBeenCalled()
  })

  it.each([
    { ...page, sourceFilter: undefined },
    { ...page, sourceFilter: { ...sourceFilter, sourceItemId: 'other' } },
    { ...page, items: [{ id: 'unlinked' }] },
  ])(
    'does not label an unsupported or unfiltered result as source history',
    async (result) => {
      vi.mocked(callPlugin).mockResolvedValue(result)
      await expect(listRecords(0, 10, undefined, source)).rejects.toThrow(
        SOURCE_UPDATE_HINT,
      )
      expect(callPlugin).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['INVALID_REQUEST: 请求参数无效', '插件未声明该方法'])(
    'shows an update hint and never falls back to unlinked paid generation: %s',
    async (error) => {
      vi.mocked(callPlugin).mockRejectedValue(error)
      await expect(generate({ ...input, source })).rejects.toThrow(SOURCE_UPDATE_HINT)
      expect(callPlugin).toHaveBeenCalledTimes(1)
      expect(vi.mocked(callPlugin).mock.calls[0]?.[2]).toBe('image.records.list')
    },
  )

  it('also translates old generate schema errors without submitting twice', async () => {
    vi.mocked(callPlugin)
      .mockResolvedValueOnce(page)
      .mockRejectedValueOnce('INVALID_REQUEST: 请求参数无效')
    await expect(generate({ ...input, source })).rejects.toThrow(SOURCE_UPDATE_HINT)
    expect(callPlugin).toHaveBeenCalledTimes(2)
  })

  it('preserves source and editable prompt after the read-only compatibility check', async () => {
    const record = { id: 'record', source } as GenerationRecord
    vi.mocked(callPlugin).mockResolvedValueOnce(page).mockResolvedValueOnce({ record })
    expect(await generate({ ...input, source })).toEqual({ record })
    expect(callPlugin).toHaveBeenNthCalledWith(
      2,
      'studio.ai-image',
      'image.provider',
      'image.generate',
      { ...input, source },
      30000,
    )
  })

  it('warns that a generation was submitted if a broken plugin loses the source', async () => {
    vi.mocked(callPlugin)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({ record: { id: 'record' } })
    await expect(generate({ ...input, source })).rejects.toThrow('勿重复提交')
    expect(callPlugin).toHaveBeenCalledTimes(2)
  })

  it('keeps legacy requests unchanged and network failures distinct from update requirements', async () => {
    vi.mocked(callPlugin).mockResolvedValueOnce({ record: { id: 'legacy' } })
    await generate(input)
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.ai-image',
      'image.provider',
      'image.generate',
      input,
      30000,
    )
    vi.mocked(callPlugin).mockRejectedValueOnce('插件进程不可用')
    await expect(listRecords(0, 10, undefined, source)).rejects.toThrow('插件进程不可用')
  })
})

describe('explicit model requests', () => {
  it.each([
    { imageModel: '' },
    { providerId: '' },
    { visionProviderId: null },
    { visionModel: null },
  ])('rejects missing model choices before any plugin call: %j', async (change) => {
    await expect(generate({ ...input, ...change })).rejects.toThrow('请选择')
    expect(callPlugin).not.toHaveBeenCalled()
  })

  it('allows text generation with only the selected image model', async () => {
    const text: GenerateInput = {
      providerId: 'image-provider',
      imageModel: 'image-model',
      mode: 'generate',
      presetId: null,
      prompt: 'A lived-in living room.',
      count: 1,
      size: 'auto',
      inputFileIds: [],
    }
    vi.mocked(callPlugin).mockResolvedValue({ record: { id: 'record' } })
    await generate(text)
    expect(vi.mocked(callPlugin).mock.calls[0]?.[3]).toEqual(text)
    expect(callPlugin).toHaveBeenCalledTimes(1)
  })
})

describe('actual provider image tests', () => {
  const testInput: ProviderImageTestInput = {
    id: 'saved-provider',
    model: 'saved-image-model',
    mode: 'generate',
    prompt: ' A blue ceramic cup on a table.\n',
    size: '1024x1024',
    inputFileIds: [],
  }

  it.each(['generate', 'edit'] as const)(
    'submits exactly one %s test without generation preferences or vision fields',
    async (mode) => {
      const request = {
        ...testInput,
        mode,
        inputFileIds: mode === 'edit' ? ['uploaded-jpeg'] : [],
      }
      const record = { id: 'test-record', purpose: 'provider-test' } as GenerationRecord
      vi.mocked(callPlugin).mockResolvedValue({ record })

      expect(await testProviderImage(request)).toEqual({ record })

      expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
        'studio.ai-image',
        'image.provider',
        'image.providers.testImage',
        request,
        30000,
      )
    },
  )

  it.each<Partial<ProviderImageTestInput>>([
    { id: ' ' },
    { model: '' },
    { prompt: ' \n ' },
    { prompt: 'a'.repeat(12001) },
    { inputFileIds: ['unexpected'] },
    { mode: 'edit', inputFileIds: [] },
    { mode: 'edit', inputFileIds: ['one', 'two'] },
    { mode: 'edit', inputFileIds: [' '] },
  ])('rejects invalid test input before RPC (case %#)', async (change) => {
    await expect(testProviderImage({ ...testInput, ...change })).rejects.toThrow()
    expect(callPlugin).not.toHaveBeenCalled()
  })

  it.each([
    '插件未声明该方法',
    'No available channel for this image model; check the gateway model channel',
  ])('preserves the actionable failure without a paid fallback: %s', async (error) => {
    vi.mocked(callPlugin).mockRejectedValue(new Error(error))

    await expect(testProviderImage(testInput)).rejects.toThrow(error)

    expect(callPlugin).toHaveBeenCalledTimes(1)
    expect(vi.mocked(callPlugin).mock.calls[0]?.[2]).toBe('image.providers.testImage')
  })
})

describe('File uploads', () => {
  it('preserves bytes across chunk boundaries without image preparation', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 12, 33, 95])
    const file = new File([bytes], 'source.png', { type: 'image/png' })
    const stored = { id: 'file', mime: 'image/png', name: file.name, bytes: bytes.length }
    vi.mocked(callPlugin).mockImplementation(async (_id, _capability, method) => {
      if (method === 'image.upload.begin') return { uploadId: 'upload', chunkSize: 4 }
      if (method === 'image.upload.finish') return { file: stored }
      return {}
    })
    expect(await uploadImage(file)).toEqual(stored)
    const calls = vi.mocked(callPlugin).mock.calls
    const chunks = calls
      .filter((call) => call[2] === 'image.upload.chunk')
      .map((call) => call[3] as { index: number; data: string })
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2])
    const transferred = chunks.flatMap((chunk) =>
      Array.from(atob(chunk.data), (character) => character.charCodeAt(0)),
    )
    expect(new Uint8Array(transferred)).toEqual(bytes)
  })

  it('aborts a partially uploaded session on failure', async () => {
    vi.mocked(callPlugin).mockImplementation(async (_id, _capability, method) => {
      if (method === 'image.upload.begin') return { uploadId: 'upload', chunkSize: 4 }
      if (method === 'image.upload.chunk') throw new Error('disk full')
      return {}
    })
    await expect(
      uploadImage(new File(['bytes'], 'source.png', { type: 'image/png' })),
    ).rejects.toThrow('disk full')
    expect(vi.mocked(callPlugin).mock.calls.map((call) => call[2])).toEqual([
      'image.upload.begin',
      'image.upload.chunk',
      'image.upload.abort',
    ])
  })

  it('cancellation after begin aborts without uploading or finishing', async () => {
    const controller = new AbortController()
    vi.mocked(callPlugin).mockImplementation(async (_id, _capability, method) => {
      if (method === 'image.upload.begin') {
        controller.abort()
        return { uploadId: 'upload', chunkSize: 4 }
      }
      return {}
    })
    await expect(
      uploadImage(
        new File(['bytes'], 'source.png', { type: 'image/png' }),
        controller.signal,
      ),
    ).rejects.toThrow()
    expect(vi.mocked(callPlugin).mock.calls.map((call) => call[2])).toEqual([
      'image.upload.begin',
      'image.upload.abort',
    ])
  })

  it('rejects invalid chunk sizes instead of looping forever', async () => {
    vi.mocked(callPlugin).mockResolvedValue({ uploadId: 'upload', chunkSize: 0 })
    await expect(
      uploadImage(new File(['bytes'], 'source.png', { type: 'image/png' })),
    ).rejects.toThrow('分块大小')
    expect(vi.mocked(callPlugin).mock.calls.map((call) => call[2])).toEqual([
      'image.upload.begin',
      'image.upload.abort',
    ])
  })
})
