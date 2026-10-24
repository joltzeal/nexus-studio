import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AiImage } from './ai-image.js'
import type { GenerationRecord, ProviderView } from '../domain/types.js'
import {
  createFileStore,
  createMemoryStore,
  type PrivateStore,
} from '../store/private-store.js'
import {
  createFileImageStore,
  createMemoryImageStore,
  type ImageStore,
} from '../store/image-files.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9])
const PNG_B64 = PNG.toString('base64')

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function imageResponse(): Response {
  return json({ data: [{ b64_json: PNG_B64 }] })
}

/**
 * `fetch` is stubbed with explicit arguments so the recorded calls keep their
 * shape: tests read `calls[0][1].body` to prove the edit path really posts a form.
 */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => await handler(url, init))
  vi.stubGlobal('fetch', mock)
  return mock
}

function setup(
  store: PrivateStore = createMemoryStore(),
  images: ImageStore = createMemoryImageStore(),
) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let counter = 0
  const plugin = new AiImage({
    store,
    images,
    logger,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    idFactory: () => `id-${String(++counter)}`,
  })
  const call = <T>(method: string, payload: unknown = {}): Promise<T> =>
    plugin.call({
      requestId: `req-${String(counter)}`,
      capability: 'image.provider',
      method,
      payload,
      deadlineAt: Date.now() + 5_000,
      assertAlive: () => undefined,
    }) as Promise<T>
  return { plugin, store, images, logger, call }
}

async function settle(
  call: <T>(method: string, payload?: unknown) => Promise<T>,
  id: string,
): Promise<GenerationRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { record } = await call<{ record: GenerationRecord }>('image.records.get', {
      id,
    })
    if (record.status !== 'running') return record
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('生成任务没有结束')
}

/** Defaults to an image-only provider; copy tests opt into the text model. */
async function addProvider(
  call: <T>(method: string, payload?: unknown) => Promise<T>,
  overrides: Record<string, unknown> = {},
): Promise<ProviderView> {
  return await call<ProviderView>('image.providers.save', {
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com',
    apiKey: 'sk-secret-value',
    imageModel: 'gpt-image-1',
    textModel: '',
    supportsVision: false,
    ...overrides,
  })
}

const VISION = { textModel: 'gpt-4o-mini', supportsVision: true }

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('模型配置', () => {
  it('保存后补齐版本段，回显时不含明文 Key', async () => {
    const { call, store } = setup()
    const saved = await addProvider(call)
    expect(saved.baseUrl).toBe('https://api.openai.com/v1')
    expect(saved.hasApiKey).toBe(true)
    expect(saved.apiKeyHint).toBe('sk-…alue')
    expect(JSON.stringify(saved)).not.toContain('sk-secret-value')
    expect((await store.read()).providers[0]?.apiKey).toBe('sk-secret-value')
  })

  it('编辑时省略 Key 会保留原值', async () => {
    const { call, store } = setup()
    const saved = await addProvider(call)
    await call('image.providers.save', {
      id: saved.id,
      name: 'OpenAI 2',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      imageModel: 'gpt-image-1',
      textModel: '',
      supportsVision: false,
    })
    const document = await store.read()
    expect(document.providers[0]?.name).toBe('OpenAI 2')
    expect(document.providers[0]?.apiKey).toBe('sk-secret-value')
  })

  it('拒绝带凭据的接口地址', async () => {
    const { call } = setup()
    await expect(
      call('image.providers.save', {
        name: 'Bad',
        kind: 'openai_compatible',
        baseUrl: 'https://user:pass@example.com/v1',
        apiKey: 'k',
        imageModel: 'm',
        textModel: '',
        supportsVision: false,
      }),
    ).rejects.toThrow('请求参数无效')
  })

  it('删除后不再出现在列表里', async () => {
    const { call } = setup()
    const saved = await addProvider(call)
    await call('image.providers.remove', { id: saved.id })
    const list = await call<{ items: ProviderView[] }>('image.providers.list')
    expect(list.items).toHaveLength(0)
  })
})

describe('生成', () => {
  it('没有配置服务商时明确要求先配置', async () => {
    const { call } = setup()
    await expect(
      call('image.generate', {
        providerId: 'missing',
        mode: 'generate',
        presetId: 'white-studio',
        prompt: '',
        size: '1024x1024',
        count: 1,
        inputFileIds: [],
      }),
    ).rejects.toThrow('请先在模型配置中保存一个服务商')
  })

  it('文生图成功后写入记录与输出文件', async () => {
    const { call, images } = setup()
    const provider = await addProvider(call)
    const fetchMock = stubFetch(() => imageResponse())

    const created = await call<{ record: GenerationRecord }>('image.generate', {
      providerId: provider.id,
      mode: 'generate',
      presetId: 'white-studio',
      prompt: '',
      size: '1024x1024',
      count: 1,
      inputFileIds: [],
    })
    expect(created.record.status).toBe('running')
    expect(created.record.prompt).toContain('white laminate table')

    const finished = await settle(call, created.record.id)
    expect(finished.status).toBe('success')
    expect(finished.outputs).toHaveLength(1)
    expect(finished.outputs[0]?.mime).toBe('image/png')
    expect(finished.title).toBeNull()

    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toBe('https://api.openai.com/v1/images/generations')
    const stored = await images.readAll(finished.outputs[0]?.id ?? '')
    expect(stored.bytes.byteLength).toBe(PNG.byteLength)
  })

  it('参考图走改图接口，表单里带 image[]', async () => {
    const { call } = setup()
    const provider = await addProvider(call)
    const fetchMock = stubFetch(() => imageResponse())

    const begun = await call<{ uploadId: string }>('image.upload.begin', {
      mime: 'image/png',
      size: PNG.byteLength,
    })
    await call('image.upload.chunk', {
      uploadId: begun.uploadId,
      index: 0,
      data: PNG_B64,
    })
    const uploaded = await call<{ file: { id: string } }>('image.upload.finish', {
      uploadId: begun.uploadId,
      name: 'reference.png',
    })

    const created = await call<{ record: GenerationRecord }>('image.generate', {
      providerId: provider.id,
      mode: 'edit',
      presetId: null,
      prompt: 'place it on a desk',
      size: 'auto',
      count: 1,
      inputFileIds: [uploaded.file.id],
    })
    const finished = await settle(call, created.record.id)
    expect(finished.status).toBe('success')
    expect(finished.mode).toBe('edit')

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toBe('https://api.openai.com/v1/images/edits')
    expect(init?.body).toBeInstanceOf(FormData)
    const form = init?.body as FormData
    expect(form.get('prompt')).toBe('place it on a desk')
    expect(form.getAll('image[]')).toHaveLength(1)
    expect(form.get('size')).toBeNull()
  })

  it('文案模型读取生成结果后写入标题与描述', async () => {
    const { call } = setup()
    const provider = await addProvider(call, VISION)
    const fetchMock = stubFetch((url) => {
      if (url.endsWith('/chat/completions')) {
        return json({
          choices: [
            {
              message: {
                content:
                  '```json\n{"title":"铁皮画","description":"做旧质感挂画。"}\n```',
              },
            },
          ],
        })
      }
      return imageResponse()
    })

    const created = await call<{ record: GenerationRecord }>('image.generate', {
      providerId: provider.id,
      mode: 'generate',
      presetId: 'home-sofa',
      prompt: '',
      size: '1024x1024',
      count: 1,
      inputFileIds: [],
    })
    const finished = await settle(call, created.record.id)
    expect(finished.title).toBe('铁皮画')
    expect(finished.description).toBe('做旧质感挂画。')
    expect(finished.copyError).toBeNull()

    // The copy model looks at the finished picture, not at the prompt text.
    const chat = fetchMock.mock.calls.find(([url]) => url.endsWith('/chat/completions'))
    const init = chat?.[1] as RequestInit | undefined
    const body = JSON.parse(String(init?.body)) as {
      messages: { content: { type: string }[] }[]
    }
    expect(body.messages[1]?.content.some((part) => part.type === 'image_url')).toBe(true)
  })

  it('鉴权失败会映射成可读错误并标记失败', async () => {
    const { call } = setup()
    const provider = await addProvider(call)
    stubFetch(() => json({ error: { message: 'invalid api key' } }, 401))

    const created = await call<{ record: GenerationRecord }>('image.generate', {
      providerId: provider.id,
      mode: 'generate',
      presetId: null,
      prompt: 'a mug',
      size: '1024x1024',
      count: 1,
      inputFileIds: [],
    })
    const finished = await settle(call, created.record.id)
    expect(finished.status).toBe('failed')
    expect(finished.error).toContain('API Key 无效')
    expect(finished.outputs).toHaveLength(0)
  })

  it('文案失败不会让图片结果作废', async () => {
    const { call } = setup()
    const provider = await addProvider(call, VISION)
    stubFetch((url) => {
      if (url.endsWith('/chat/completions')) {
        return json({ error: { message: 'model overloaded' } }, 500)
      }
      return imageResponse()
    })

    const created = await call<{ record: GenerationRecord }>('image.generate', {
      providerId: provider.id,
      mode: 'generate',
      presetId: null,
      prompt: 'a mug',
      size: '1024x1024',
      count: 1,
      inputFileIds: [],
    })
    const finished = await settle(call, created.record.id)
    expect(finished.status).toBe('success')
    expect(finished.outputs).toHaveLength(1)
    expect(finished.copyError).not.toBeNull()
  })

  it('空提示词与自由预设组合会被拒绝', async () => {
    const { call } = setup()
    const provider = await addProvider(call)
    await expect(
      call('image.generate', {
        providerId: provider.id,
        mode: 'generate',
        presetId: null,
        prompt: '   ',
        size: '1024x1024',
        count: 1,
        inputFileIds: [],
      }),
    ).rejects.toThrow('请填写提示词或选择一个场景预设')
  })

  it('改图缺少参考图时拒绝提交', async () => {
    const { call } = setup()
    const provider = await addProvider(call)
    await expect(
      call('image.generate', {
        providerId: provider.id,
        mode: 'edit',
        presetId: null,
        prompt: 'x',
        size: '1024x1024',
        count: 1,
        inputFileIds: [],
      }),
    ).rejects.toThrow('改图至少需要一张参考图片')
  })
})

describe('记录', () => {
  it('按状态筛选，并能在删除时清理输出文件', async () => {
    const { call, images } = setup()
    const provider = await addProvider(call)
    stubFetch(() => imageResponse())
    const created = await call<{ record: GenerationRecord }>('image.generate', {
      providerId: provider.id,
      mode: 'generate',
      presetId: null,
      prompt: 'a mug',
      size: '1024x1024',
      count: 1,
      inputFileIds: [],
    })
    const finished = await settle(call, created.record.id)
    const outputId = finished.outputs[0]?.id ?? ''

    const success = await call<{ items: GenerationRecord[]; total: number }>(
      'image.records.list',
      { page: 0, size: 10, status: 'success' },
    )
    expect(success.total).toBe(1)
    const failed = await call<{ items: GenerationRecord[] }>('image.records.list', {
      page: 0,
      size: 10,
      status: 'failed',
    })
    expect(failed.items).toHaveLength(0)

    await call('image.records.remove', { id: finished.id })
    await expect(images.readAll(outputId)).rejects.toThrow('图片文件不存在')
    const after = await call<{ total: number }>('image.records.list', {
      page: 0,
      size: 10,
    })
    expect(after.total).toBe(0)
  })

  it('上传分块总大小不足时拒绝结束', async () => {
    const { call } = setup()
    const begun = await call<{ uploadId: string }>('image.upload.begin', {
      mime: 'image/png',
      size: 100,
    })
    await call('image.upload.chunk', {
      uploadId: begun.uploadId,
      index: 0,
      data: PNG_B64,
    })
    await expect(
      call('image.upload.finish', { uploadId: begun.uploadId, name: 'a.png' }),
    ).rejects.toThrow('图片上传未完成')
  })

  it('导出会把输出复制到 exports 目录（内存存储拒绝）', async () => {
    const { call } = setup()
    const provider = await addProvider(call)
    stubFetch(() => imageResponse())
    const created = await call<{ record: GenerationRecord }>('image.generate', {
      providerId: provider.id,
      mode: 'generate',
      presetId: null,
      prompt: 'a mug',
      size: '1024x1024',
      count: 1,
      inputFileIds: [],
    })
    const finished = await settle(call, created.record.id)
    await expect(call('image.records.export', { id: finished.id })).rejects.toThrow(
      '宿主未提供私有目录',
    )
  })
})

describe('remote image uploads', () => {
  it('下载远程图片并按字节判断格式', async () => {
    const { call, images } = setup()
    const mock = stubFetch(
      () =>
        new Response(PNG, {
          status: 200,
          // A CDN that serves photos as octet-stream must still work.
          headers: { 'content-type': 'application/octet-stream' },
        }),
    )
    const result = await call<{ file: { id: string; name: string; mime: string } }>(
      'image.upload.remote',
      { url: 'https://cdn.example.com/photos/abc123.jpg' },
    )
    expect(mock).toHaveBeenCalledWith(
      'https://cdn.example.com/photos/abc123.jpg',
      expect.objectContaining({ redirect: 'follow' }),
    )
    expect(result.file.mime).toBe('image/png')
    expect(result.file.name).toBe('abc123.png')
    const stored = await images.readAll(result.file.id)
    expect(stored.mime).toBe('image/png')
    expect(stored.bytes.byteLength).toBe(PNG.byteLength)
  })

  it('调用方给的名字优先于链接里的文件名', async () => {
    const { call } = setup()
    stubFetch(() => new Response(PNG, { status: 200 }))
    const result = await call<{ file: { name: string } }>('image.upload.remote', {
      url: 'https://cdn.example.com/photos/abc123.jpg',
      name: '商品主图.png',
    })
    expect(result.file.name).toBe('商品主图.png')
  })

  it('不是图片的内容被拒绝', async () => {
    const { call } = setup()
    stubFetch(() => new Response('<html>not an image</html>', { status: 200 }))
    await expect(
      call('image.upload.remote', { url: 'https://cdn.example.com/page.html' }),
    ).rejects.toThrow('不是 JPEG、PNG 或 WebP 图片')
  })

  it('链接返回错误状态时报错', async () => {
    const { call } = setup()
    stubFetch(() => new Response('', { status: 404 }))
    await expect(
      call('image.upload.remote', { url: 'https://cdn.example.com/missing.jpg' }),
    ).rejects.toThrow('404')
  })

  it('声明体积超过上限时不下载', async () => {
    const { call } = setup()
    const mock = stubFetch(
      () =>
        new Response(PNG, {
          status: 200,
          headers: { 'content-length': String(9 * 1024 * 1024) },
        }),
    )
    await expect(
      call('image.upload.remote', { url: 'https://cdn.example.com/huge.jpg' }),
    ).rejects.toThrow('8 MB')
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('只接受 http(s) 链接', async () => {
    const { call } = setup()
    await expect(
      call('image.upload.remote', { url: 'file:///etc/passwd' }),
    ).rejects.toThrow('请求参数无效')
  })
})

const SECOND_PNG = Buffer.concat([PNG, Buffer.from('second-image')])
const OBSERVATION = 'A used blue mug with a chipped rim and the readable marking ABC.'
const GENERATION_INPUT = {
  mode: 'edit',
  presetId: 'home-sofa',
  prompt: 'Keep the chip and every letter.',
  size: 'auto',
  count: 1,
  inputFileIds: ['source-one', 'source-two'],
}

function visionResponse(): Response {
  return json({
    choices: [{ message: { content: JSON.stringify({ description: OBSERVATION }) } }],
  })
}

function chatBody(init: RequestInit | undefined): {
  model: string
  messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[]
} {
  return JSON.parse(String(init?.body)) as ReturnType<typeof chatBody>
}

async function references(images: ImageStore) {
  await images.write('source-one', 'image/png', PNG)
  await images.write('source-two', 'image/png', SECOND_PNG)
}

async function waitOutput(call: ReturnType<typeof setup>['call'], id: string) {
  return vi.waitFor(async () => {
    const { record } = await call<{ record: GenerationRecord }>('image.records.get', {
      id,
    })
    expect(record.outputVision?.status).not.toBe('running')
    expect(record.outputVision).toBeTruthy()
    return record
  })
}

describe('独立识图与原图选择', () => {
  it('旧服务商编辑不清空新增识图配置；可显式清空或创建只识图配置', async () => {
    const { call } = setup()
    const provider = await addProvider(call, {
      imageModel: '',
      visionModel: 'vision-only',
    })
    expect(provider.visionModel).toBe('vision-only')
    const edited = await addProvider(call, { id: provider.id })
    expect(edited.visionModel).toBe('vision-only')
    const cleared = await addProvider(call, { id: provider.id, visionModel: '' })
    expect(cleared.visionModel).toBe('')
    const old = await addProvider(call)
    expect(old.visionModel).toBe('')
  })

  it.each([undefined, 'source-two'])(
    '使用独立模型且只发送选定原图 %s',
    async (visionFileId) => {
      const { call, images } = setup()
      await references(images)
      const generator = await addProvider(call, {
        imageModel: 'image-chosen',
        textModel: 'copy-chosen',
        supportsVision: false,
      })
      const vision = await addProvider(call, {
        name: '独立识图',
        kind: 'openai_compatible',
        baseUrl: 'https://vision.example.test/v1',
        apiKey: 'vision-key',
        imageModel: '',
        visionModel: 'vision-chosen',
      })
      const fetchMock = stubFetch((url) => {
        if (url.startsWith(vision.baseUrl)) return visionResponse()
        if (url.endsWith('/chat/completions'))
          return json({
            choices: [
              {
                message: {
                  content: '{"title":"缺口杯","description":"有缺口和可读文字。"}',
                },
              },
            ],
          })
        return imageResponse()
      })
      const created = await call<{ record: GenerationRecord }>('image.generate', {
        ...GENERATION_INPUT,
        providerId: generator.id,
        visionProviderId: vision.id,
        ...(visionFileId === undefined ? {} : { visionFileId }),
      })
      const result = await settle(call, created.record.id)
      expect(result.status).toBe('success')
      expect(result.vision?.model).toBe('vision-chosen')
      expect(result.vision?.inputFileId).toBe(visionFileId ?? 'source-one')
      expect(result.vision?.description).toBe(OBSERVATION)
      const [url, init] = fetchMock.mock.calls[0] ?? []
      expect(url).toBe('https://vision.example.test/v1/chat/completions')
      expect(init?.headers).toMatchObject({ authorization: 'Bearer vision-key' })
      const request = chatBody(init)
      expect(request.model).toBe('vision-chosen')
      expect(
        request.messages[1]?.content.filter((part) => part.type === 'image_url'),
      ).toEqual([
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${(visionFileId ? SECOND_PNG : PNG).toString('base64')}`,
          },
        },
      ])
      const form = fetchMock.mock.calls[1]?.[1]?.body as FormData
      expect(form.get('model')).toBe('image-chosen')
      expect(form.getAll('image[]')).toHaveLength(2)
      expect(form.get('prompt')).toContain(OBSERVATION)
      expect(form.get('prompt')).toContain(GENERATION_INPUT.prompt)
      const copy = chatBody(fetchMock.mock.calls[2]?.[1])
      expect(copy.model).toBe('copy-chosen')
      expect(
        copy.messages[1]?.content.filter((part) => part.type === 'image_url'),
      ).toHaveLength(0)
      expect(copy.messages[1]?.content[0]?.text).toContain(OBSERVATION)
    },
  )

  it('不会把旧文案模型当作独立识图模型或接受其他记录的图片', async () => {
    const { call, images } = setup()
    await references(images)
    const generator = await addProvider(call, VISION)
    const vision = await addProvider(call, { visionModel: 'vision' })
    const fetchMock = stubFetch(() => imageResponse())
    await expect(
      call('image.generate', {
        ...GENERATION_INPUT,
        providerId: generator.id,
        visionProviderId: generator.id,
      }),
    ).rejects.toThrow('未配置独立识图模型')
    await expect(
      call('image.generate', {
        ...GENERATION_INPUT,
        providerId: generator.id,
        visionProviderId: vision.id,
        visionFileId: 'foreign',
      }),
    ).rejects.toThrow('请选择参考图片中的一张')
    await expect(
      call('image.generate', {
        ...GENERATION_INPUT,
        providerId: generator.id,
        visionFileId: 'source-one',
      }),
    ).rejects.toThrow('必须指定独立识图服务商')
    await expect(
      call('image.generate', {
        ...GENERATION_INPUT,
        mode: 'generate',
        inputFileIds: [],
        providerId: generator.id,
        visionProviderId: vision.id,
      }),
    ).rejects.toThrow('请选择参考图片中的一张')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['http', 'invalid', 'empty', 'timeout'])(
    '识图失败 %s 阻断生图且不回退',
    async (failure) => {
      const { call, images } = setup()
      await references(images)
      const provider = await addProvider(call, { visionModel: 'vision' })
      const fetchMock = stubFetch(() => {
        if (failure === 'timeout') throw new DOMException('timeout', 'TimeoutError')
        if (failure === 'http')
          return json({ error: { message: 'model unavailable' } }, 404)
        if (failure === 'empty')
          return json({ choices: [{ message: { content: '{"description":""}' } }] })
        return json({ choices: [{ message: { content: 'not JSON' } }] })
      })
      const { record } = await call<{ record: GenerationRecord }>('image.generate', {
        ...GENERATION_INPUT,
        providerId: provider.id,
        visionProviderId: provider.id,
      })
      const result = await settle(call, record.id)
      expect(result.status).toBe('failed')
      expect(result.error).toContain('识图失败')
      expect(result.outputs).toHaveLength(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/chat/completions')
    },
  )

  it('重启后重试沿用原识图模型与图片，且不重复叠加观察内容', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-vision-'))
    directories.push(directory)
    const first = setup(
      createFileStore(directory),
      createFileImageStore(join(directory, 'images')),
    )
    await references(first.images)
    const provider = await addProvider(first.call, { visionModel: 'vision-original' })
    stubFetch((url) =>
      url.endsWith('/chat/completions')
        ? visionResponse()
        : json({ error: 'failed' }, 500),
    )
    const created = await first.call<{ record: GenerationRecord }>('image.generate', {
      ...GENERATION_INPUT,
      providerId: provider.id,
      visionProviderId: provider.id,
      visionFileId: 'source-two',
    })
    expect((await settle(first.call, created.record.id)).status).toBe('failed')
    await vi.waitFor(() => expect(first.plugin.status()['running']).toBe(0))
    await addProvider(first.call, {
      id: provider.id,
      visionModel: 'vision-new',
      imageModel: 'image-new',
    })
    const second = setup(
      createFileStore(directory),
      createFileImageStore(join(directory, 'images')),
    )
    const fetchMock = stubFetch((url) =>
      url.endsWith('/chat/completions') ? visionResponse() : imageResponse(),
    )
    await second.call('image.records.retry', { id: created.record.id })
    const result = await settle(second.call, created.record.id)
    expect(result.status).toBe('success')
    expect(chatBody(fetchMock.mock.calls[0]?.[1]).model).toBe('vision-original')
    expect(
      chatBody(fetchMock.mock.calls[0]?.[1]).messages[1]?.content[1]?.image_url?.url,
    ).toBe(`data:image/png;base64,${SECOND_PNG.toString('base64')}`)
    const form = fetchMock.mock.calls[1]?.[1]?.body as FormData
    expect(form.get('model')).toBe('gpt-image-1')
    expect(String(form.get('prompt')).split('Source-photo observations')).toHaveLength(2)
    const persisted = JSON.parse(
      await readFile(join(directory, 'ai-image.json'), 'utf8'),
    ) as { records: GenerationRecord[] }
    expect(persisted.records[0]?.vision?.inputFileId).toBe('source-two')
  })

  it('参考图丢失的重试明确失败，不丢图后继续或改走文生图', async () => {
    const { call, images, plugin } = setup()
    await references(images)
    const provider = await addProvider(call)
    stubFetch(() => json({ error: 'failed' }, 500))
    const created = await call<{ record: GenerationRecord }>('image.generate', {
      ...GENERATION_INPUT,
      providerId: provider.id,
    })
    await settle(call, created.record.id)
    await vi.waitFor(() => expect(plugin.status()['running']).toBe(0))
    await images.remove('source-two')
    const fetchMock = stubFetch(() => imageResponse())
    await call('image.records.retry', { id: created.record.id })
    const result = await settle(call, created.record.id)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('图片文件不存在')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('长附加要求尾部实际进入请求，不静默裁剪', async () => {
    const { call } = setup()
    const provider = await addProvider(call)
    const fetchMock = stubFetch(() => imageResponse())
    const prompt = `${'preserve condition; '.repeat(500)}END-KEEP-MARKINGS`
    const created = await call<{ record: GenerationRecord }>('image.generate', {
      ...GENERATION_INPUT,
      mode: 'generate',
      inputFileIds: [],
      providerId: provider.id,
      prompt,
    })
    await settle(call, created.record.id)
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      prompt: string
    }
    expect(body.prompt.endsWith(prompt)).toBe(true)
  })
})

describe('已生成组图的单张重识图', () => {
  async function generated() {
    const instance = setup()
    const provider = await addProvider(instance.call, { visionModel: 'vision-original' })
    stubFetch(() =>
      json({
        data: [{ b64_json: PNG_B64 }, { b64_json: SECOND_PNG.toString('base64') }],
      }),
    )
    const { record } = await instance.call<{ record: GenerationRecord }>(
      'image.generate',
      {
        ...GENERATION_INPUT,
        mode: 'generate',
        inputFileIds: [],
        count: 2,
        providerId: provider.id,
      },
    )
    const result = await settle(instance.call, record.id)
    await vi.waitFor(() => expect(instance.plugin.status()['running']).toBe(0))
    return { ...instance, provider, record: result }
  }

  it.each([0, 1])('仅将成片 %s 发给指定识图模型，不重新生成图片', async (index) => {
    const { call, provider, record, store } = await generated()
    const distinct = await addProvider(call, {
      imageModel: '',
      visionModel: 'output-vision',
      baseUrl: 'https://vision.example.test/v1',
    })
    const fetchMock = stubFetch(() => visionResponse())
    await call('image.records.recognize', {
      id: record.id,
      providerId: distinct.id,
      ...(index === 0 ? {} : { fileId: record.outputs[index]?.id }),
    })
    const result = await waitOutput(call, record.id)
    expect(result.status).toBe('success')
    expect(result.outputs).toEqual(record.outputs)
    expect(result.providerId).toBe(provider.id)
    expect(result.outputVision?.status).toBe('success')
    expect(result.outputVision?.outputFileId).toBe(record.outputs[index]?.id)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://vision.example.test/v1/chat/completions',
    )
    const request = chatBody(fetchMock.mock.calls[0]?.[1])
    expect(request.model).toBe('output-vision')
    expect(
      request.messages[1]?.content.filter((part) => part.type === 'image_url'),
    ).toEqual([
      {
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${(index === 0 ? PNG : SECOND_PNG).toString('base64')}`,
        },
      },
    ])
    expect((await store.read()).records[0]?.outputVision?.description).toBe(OBSERVATION)
  })

  it('失败保留成片且重试固定原模型原图片，拒绝重试时偷换选择', async () => {
    const { call, provider, record, plugin } = await generated()
    stubFetch(() => json({ error: 'unavailable' }, 500))
    await call('image.records.recognize', {
      id: record.id,
      providerId: provider.id,
      fileId: record.outputs[1]?.id,
    })
    const failed = await waitOutput(call, record.id)
    expect(failed.status).toBe('success')
    expect(failed.outputVision?.status).toBe('failed')
    expect(failed.outputVision?.error).not.toBeNull()
    await vi.waitFor(() => expect(plugin.status()['running']).toBe(0))
    await addProvider(call, { id: provider.id, visionModel: 'vision-new' })
    const fetchMock = stubFetch(() => visionResponse())
    await expect(
      call('image.records.recognize', {
        id: record.id,
        retry: true,
        fileId: record.outputs[0]?.id,
      }),
    ).rejects.toThrow('请求参数无效')
    await call('image.records.recognize', { id: record.id, retry: true })
    const result = await waitOutput(call, record.id)
    expect(result.outputVision?.status).toBe('success')
    const body = chatBody(fetchMock.mock.calls[0]?.[1])
    expect(body.model).toBe('vision-original')
    expect(body.messages[1]?.content[1]?.image_url?.url).toBe(
      `data:image/png;base64,${SECOND_PNG.toString('base64')}`,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('非本记录成片或缺失成片明确拒绝，不退回第一张', async () => {
    const { call, provider, record, images } = await generated()
    const fetchMock = stubFetch(() => visionResponse())
    await expect(
      call('image.records.recognize', {
        id: record.id,
        providerId: provider.id,
        fileId: 'foreign',
      }),
    ).rejects.toThrow('必须属于这条记录的成片')
    const selectedId = record.outputs[1]?.id ?? ''
    await images.remove(selectedId)
    await expect(
      call('image.records.recognize', {
        id: record.id,
        providerId: provider.id,
        fileId: selectedId,
      }),
    ).rejects.toThrow('图片文件不存在')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('重启后的成片识图中断记录可见失败，并能沿用存储的模型和图片重试', async () => {
    const { record, provider, images, store } = await generated()
    const directory = await mkdtemp(join(tmpdir(), 'nexus-output-vision-'))
    directories.push(directory)
    const durable = createFileStore(directory)
    const original = await store.read()
    await durable.mutate((document) => {
      document.providers = original.providers
      document.records = [
        {
          ...record,
          outputVision: {
            providerId: provider.id,
            providerName: provider.name,
            providerKind: provider.kind,
            model: 'vision-before-restart',
            outputFileId: record.outputs[1]?.id ?? '',
            status: 'running',
            description: null,
            error: null,
          },
        },
      ]
    })
    const reopened = setup(createFileStore(directory), images)
    const fetchMock = stubFetch(() => visionResponse())
    const read = await reopened.call<{ record: GenerationRecord }>('image.records.get', {
      id: record.id,
    })
    expect(read.record.outputVision?.status).toBe('failed')
    expect(read.record.outputVision?.error).toContain('已中断')
    expect(fetchMock).not.toHaveBeenCalled()
    await reopened.call('image.records.recognize', { id: record.id, retry: true })
    const result = await waitOutput(reopened.call, record.id)
    expect(result.outputVision?.status).toBe('success')
    const body = chatBody(fetchMock.mock.calls[0]?.[1])
    expect(body.model).toBe('vision-before-restart')
    expect(
      body.messages[1]?.content.filter((part) => part.type === 'image_url'),
    ).toHaveLength(1)
    expect(body.messages[1]?.content[1]?.image_url?.url).toBe(
      `data:image/png;base64,${SECOND_PNG.toString('base64')}`,
    )
  })
})
