import { afterEach, describe, expect, it, vi } from 'vitest'

import { AiImage } from './ai-image.js'
import type { GenerationRecord, ProviderView } from '../domain/types.js'
import { createMemoryStore } from '../store/private-store.js'
import { createMemoryImageStore } from '../store/image-files.js'

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

function setup() {
  const store = createMemoryStore()
  const images = createMemoryImageStore()
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

afterEach(() => {
  vi.unstubAllGlobals()
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
    expect(created.record.prompt).toContain('seamless pure white studio background')

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
