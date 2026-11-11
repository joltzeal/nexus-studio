import { afterEach, describe, expect, it, vi } from 'vitest'
import { callPlugin } from '@/lib/platform/native-plugins'
import { listRecords } from './api'
import { makeSceneRecord } from './scene-plan.test-data'
import { statusText } from './types'

vi.mock('@/lib/platform/native-plugins', () => ({ callPlugin: vi.fn() }))
afterEach(() => vi.resetAllMocks())

const source = {
  pluginId: 'studio.vinted-monitor',
  itemId: 'vinted.fr:123',
}
const sourceFilter = { sourcePluginId: source.pluginId, sourceItemId: source.itemId }

function page(extra: Record<string, unknown> = {}) {
  return {
    items: [],
    total: 0,
    page: 0,
    pageSize: 10,
    storageDurable: true,
    ...extra,
  }
}

describe('batch history filters', () => {
  it('sends normalized search and batch filters alongside exact source identity', async () => {
    const historyFilters = { query: 'Cabinet front', kind: 'scene' as const }
    vi.mocked(callPlugin).mockResolvedValue(page({ sourceFilter, historyFilters }))
    await listRecords(0, 10, 'failed', source, {
      query: '  Cabinet front  ',
      kind: 'scene',
    })
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.ai-image',
      'image.provider',
      'image.records.list',
      { page: 0, size: 10, status: 'failed', ...sourceFilter, ...historyFilters },
      30000,
    )
  })

  it.each([
    {},
    { historyFilters: { query: 'ignored' } },
    { historyFilters: { query: 'Cabinet', kind: 'single' } },
  ])('does not present ignored filters as empty history: %j', async (reply) => {
    vi.mocked(callPlugin).mockResolvedValue(page(reply))
    await expect(
      listRecords(0, 10, undefined, undefined, {
        query: 'Cabinet',
        kind: 'scene',
      }),
    ).rejects.toThrow('更新 AI 生图插件')
    expect(callPlugin).toHaveBeenCalledTimes(1)
  })

  it('distinguishes waiting scene batches from actively executing views', () => {
    const scene = makeSceneRecord()
    scene.status = 'running'
    scene.stage = 'queued'
    scene.scenePlan!.views[0]!.status = 'queued'
    expect(statusText(scene)).toBe('排队中 · 2/3')
    scene.stage = 'image'
    scene.scenePlan!.views[0]!.status = 'running'
    expect(statusText(scene)).toBe('正在生成视角 · 2/3')
  })
})
