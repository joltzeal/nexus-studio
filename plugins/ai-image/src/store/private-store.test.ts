import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createFileStore, createMemoryStore } from './private-store.js'
import type { GenerationRecord, ProviderRecord } from '../domain/types.js'

const directories: string[] = []

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-ai-image-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

const provider: ProviderRecord = {
  id: 'p1',
  name: 'OpenAI',
  kind: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  imageModel: 'gpt-image-1',
  textModel: 'gpt-4o-mini',
  supportsVision: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const record: GenerationRecord = {
  id: 'r1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'success',
  stage: 'done',
  mode: 'edit',
  prompt: 'prompt',
  presetId: 'white-studio',
  presetLabel: '纯白棚拍',
  size: '1024x1024',
  count: 1,
  providerId: 'p1',
  providerName: 'OpenAI',
  providerKind: 'openai',
  imageModel: 'gpt-image-1',
  textModel: 'gpt-4o-mini',
  inputs: [],
  outputs: [],
  title: null,
  description: null,
  error: null,
  copyError: null,
  durationMs: null,
}

describe('私有存储', () => {
  it('文件存储在重启后仍保留服务商与记录', async () => {
    const directory = await temporary()
    const first = createFileStore(directory)
    await first.mutate((document) => {
      document.providers.push(provider)
      document.records.push(record)
    })

    const second = createFileStore(directory)
    const document = await second.read()
    expect(document.providers).toHaveLength(1)
    expect(document.providers[0]?.apiKey).toBe('sk-test')
    expect(document.providers[0]?.visionModel).toBe('')
    expect(document.records[0]?.id).toBe('r1')
    expect(document.records[0]?.vision).toBeNull()
    expect(document.records[0]?.outputVision).toBeNull()
    expect(document.records[0]?.presetId).toBe('white-studio')
    expect(document.records[0]?.presetLabel).toBe('纯白棚拍')
    expect(document.records[0]?.prompt).toBe('prompt')
  })

  it('写入失败时不会替换已保存的文档', async () => {
    const directory = await temporary()
    const store = createFileStore(directory)
    await store.mutate((document) => {
      document.providers.push(provider)
    })
    await expect(
      store.mutate((document) => {
        document.providers = []
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const document = await store.read()
    expect(document.providers).toHaveLength(1)
  })

  it('文件权限为 0600', async () => {
    const directory = await temporary()
    const store = createFileStore(directory)
    await store.mutate((document) => {
      document.providers.push(provider)
    })
    const text = await readFile(join(directory, 'ai-image.json'), 'utf8')
    expect(text).toContain('"schemaVersion": 1')
    const { stat } = await import('node:fs/promises')
    const mode = (await stat(join(directory, 'ai-image.json'))).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('内存存储标记为不可持久化', async () => {
    const store = createMemoryStore()
    expect(store.durable).toBe(false)
    await store.mutate((document) => {
      document.providers.push(provider)
    })
    expect((await store.read()).providers).toHaveLength(1)
  })

  it('结构损坏时明确报错而不是覆盖', async () => {
    const directory = await temporary()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(directory, 'ai-image.json'), '{"schemaVersion": 2}')
    const store = createFileStore(directory)
    await expect(store.read()).rejects.toThrow('插件私有存储结构无效')
  })

  it('独立识图与成片识图的选择、错误和模型快照重启后保留', async () => {
    const directory = await temporary()
    const store = createFileStore(directory)
    const file = { id: 'input', name: 'input.png', mime: 'image/png', bytes: 12 }
    const output = { ...file, id: 'output', name: 'output.png' }
    const vision = {
      providerId: 'p1',
      providerName: 'OpenAI',
      providerKind: 'openai' as const,
      model: 'vision-saved',
      inputFileId: file.id,
      description: 'A chipped mug.',
    }
    const outputVision = {
      providerId: 'p1',
      providerName: 'OpenAI',
      providerKind: 'openai' as const,
      model: 'output-vision-saved',
      outputFileId: output.id,
      status: 'failed' as const,
      description: null,
      error: '模型暂不可用',
    }
    await store.mutate((document) => {
      document.providers.push({ ...provider, visionModel: 'vision-current' })
      document.records.push({
        ...record,
        basePrompt: 'original constraints',
        inputs: [file],
        outputs: [output],
        vision,
        outputVision,
      })
    })
    const reopened = await createFileStore(directory).read()
    expect(reopened.records[0]?.vision).toEqual(vision)
    expect(reopened.records[0]?.outputVision).toEqual(outputVision)
    expect(reopened.records[0]?.basePrompt).toBe('original constraints')
    expect(reopened.providers[0]?.visionModel).toBe('vision-current')
  })

  it('持久化中的识图选择损坏时拒绝读取，不改用第一张', async () => {
    const directory = await temporary()
    const store = createFileStore(directory)
    await store.mutate((document) => {
      document.records.push({
        ...record,
        vision: {
          providerId: 'p1',
          providerName: 'OpenAI',
          providerKind: 'openai',
          model: 'vision',
          inputFileId: 'missing',
          description: null,
        },
      })
    })
    await expect(createFileStore(directory).read()).rejects.toThrow(
      '插件私有存储结构无效',
    )
  })
})
