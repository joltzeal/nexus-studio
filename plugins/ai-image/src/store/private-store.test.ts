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
    expect(document.records[0]?.id).toBe('r1')
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
})
