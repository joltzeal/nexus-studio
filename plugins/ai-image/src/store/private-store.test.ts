import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createFileStore, createMemoryStore } from './private-store.js'
import type { GenerationRecord, ProviderRecord, ScenePlan } from '../domain/types.js'

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

const plan: ScenePlan = {
  id: 'plan-1',
  createdAt: '2026-10-25T00:00:00.000Z',
  updatedAt: '2026-10-25T00:00:00.000Z',
  status: 'success',
  providerId: 'p1',
  providerName: 'OpenAI',
  providerKind: 'openai',
  model: 'vision-frozen',
  inputFileId: 'input',
  requirements: '保留原文字',
  count: 1,
  result: {
    product: '装饰画牌',
    material: '疑似金属，无法从此照片确认',
    observations: '可见正面字样和边角磨损',
    uncertainties: '背面、厚度、安装方式不可见',
    presetId: 'home-sofa',
    reason: '适合普通住家客厅',
    prompt: 'Place the unchanged item in a modest living room.',
    views: [{ id: 'front', label: '正面', prompt: 'Show only the visible front.' }],
  },
  error: null,
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
    expect(document.records[0]).not.toHaveProperty('source')
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

  it('rejects invalid persisted source metadata instead of silently dropping it', async () => {
    const directory = await temporary()
    const file = join(directory, 'ai-image.json')
    const { writeFile } = await import('node:fs/promises')
    const text = JSON.stringify({
      schemaVersion: 1,
      providers: [],
      records: [
        {
          ...record,
          source: {
            pluginId: 'studio.vinted-monitor',
            itemId: 'vinted.fr:123',
            title: 'mug',
            url: 'https://user:pass@example.test/items/123',
          },
        },
      ],
    })
    await writeFile(file, text)
    const store = createFileStore(directory)
    await expect(store.read()).rejects.toThrow('插件私有存储结构无效')
    await expect(store.mutate((document) => document.records.splice(0))).rejects.toThrow(
      '插件私有存储结构无效',
    )
    expect(await readFile(file, 'utf8')).toBe(text)
  })

  it('reads legacy documents without plans and preserves unknown fields through later writes', async () => {
    const directory = await temporary()
    const file = join(directory, 'ai-image.json')
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        futureDocument: { keep: true },
        providers: [{ ...provider, futureProvider: 'keep' }],
        records: [{ ...record, futureRecord: ['keep'] }],
      }),
    )
    const store = createFileStore(directory)
    const legacy = await store.read()
    expect(legacy.plans).toEqual([])
    expect(legacy.records[0]).not.toHaveProperty('scenePlan')
    expect(legacy.records[0]).not.toHaveProperty('source')
    await store.mutate((document) => {
      document.providers[0]!.name = 'updated'
    })
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      futureDocument: { keep: true },
      providers: [{ name: 'updated', futureProvider: 'keep' }],
      records: [{ futureRecord: ['keep'] }],
    })
  })

  it('preserves unknown planning/snapshot fields without changing frozen prompts or selected files', async () => {
    const directory = await temporary()
    const file = join(directory, 'ai-image.json')
    const enriched = {
      ...plan,
      futurePlan: true,
      result: {
        ...plan.result,
        futureResult: 'keep',
        views: plan.result!.views.map((view) => ({ ...view, futureView: 'keep' })),
      },
    }
    const saved = {
      ...record,
      count: 1,
      inputs: [{ id: 'input', name: 'input.png', mime: 'image/png', bytes: 12 }],
      outputs: [{ id: 'output', name: 'output.png', mime: 'image/png', bytes: 12 }],
      scenePlan: {
        plan: enriched,
        prompt: 'Edited scene.',
        futureSnapshot: 'keep',
        views: [
          {
            ...plan.result!.views[0],
            status: 'success',
            outputFileId: 'output',
            error: null,
            effectivePrompt: 'Frozen effective prompt\nincluding exact requirements.',
            futureViewRecord: 'keep',
          },
        ],
      },
    }
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        providers: [provider],
        records: [saved],
        plans: [enriched],
      }),
    )
    const store = createFileStore(directory)
    expect((await store.read()).plans[0]).toEqual(enriched)
    await store.mutate((document) => {
      document.providers[0]!.imageModel = 'changed'
    })
    const reopened = await createFileStore(directory).read()
    expect(reopened.records[0]?.scenePlan).toEqual(saved.scenePlan)
    expect(reopened.plans[0]).toEqual(enriched)
    expect(reopened.records[0]?.imageModel).toBe(record.imageModel)
  })

  it.each(['input', 'view id', 'output', 'count'] as const)(
    'rejects persisted smart %s inconsistencies without dropping the snapshot',
    async (invalid) => {
      const directory = await temporary()
      const store = createFileStore(directory)
      const saved: GenerationRecord = {
        ...record,
        count: invalid === 'count' ? 2 : 1,
        inputs: [
          {
            id: invalid === 'input' ? 'different' : 'input',
            name: 'input.png',
            mime: 'image/png',
            bytes: 12,
          },
        ],
        outputs: [{ id: 'output', name: 'output.png', mime: 'image/png', bytes: 12 }],
        scenePlan: {
          plan,
          prompt: 'Edited scene.',
          views: [
            {
              ...plan.result!.views[0]!,
              id: invalid === 'view id' ? 'invented' : 'front',
              status: 'success',
              outputFileId: invalid === 'output' ? 'foreign-output' : 'output',
              error: null,
              effectivePrompt: 'Frozen effective prompt.',
            },
          ],
        },
      }
      await store.mutate((document) => {
        document.records.push(saved)
      })
      await expect(createFileStore(directory).read()).rejects.toThrow(
        '插件私有存储结构无效',
      )
    },
  )
})
