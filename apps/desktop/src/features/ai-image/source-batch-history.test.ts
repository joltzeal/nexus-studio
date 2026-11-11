import type {
  ChangeEvent,
  DependencyList,
  EffectCallback,
  MouseEvent,
  ReactNode,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import type { PluginView } from '@/lib/platform/native-plugins'
import {
  components,
  deferred,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { watchPluginCatalog } from '@/features/plugins/watch-plugin-catalog'
import { listProviders, listRecords } from './api'
import { BatchSummary } from './batch-summary'
import { RecordDetailDialog } from './detail-dialog'
import { SourceImageHistoryDialog } from './source-image-history-dialog'
import { makeSceneRecord } from './scene-plan.test-data'
import type { RecordPage } from './types'

const state = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : react.useEffect(effect, deps),
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  }
})
vi.mock('@/lib/platform/native-plugins', () => ({ pluginHostAvailable: () => true }))
vi.mock('@/features/plugins/watch-plugin-catalog', () => ({
  watchPluginCatalog: vi.fn(() => () => undefined),
}))
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  listRecords: vi.fn(),
  listProviders: vi.fn(),
}))

const source = {
  pluginId: 'studio.vinted-monitor',
  itemId: 'vinted.fr:123',
  title: 'Cabinet',
  url: 'https://vinted.fr/items/123',
}
let hooks: KernelHookHarness
let render: () => ReactNode

function result(overrides: Partial<RecordPage> = {}): RecordPage {
  return {
    items: [makeSceneRecord()],
    total: 11,
    page: 0,
    pageSize: 10,
    storageDurable: true,
    ...overrides,
  }
}

async function settle() {
  render()
  hooks.flushEffects()
  await flushPromises()
}

function button(label: string) {
  return components(render(), Button).find((node) => text(node.props.children) === label)!
}

function publishStatus(status: PluginView['status']) {
  vi.mocked(watchPluginCatalog).mock.calls[0]![0]([
    {
      id: 'studio.ai-image',
      enabled: true,
      state: 'running',
      status,
    } as PluginView,
  ])
}

beforeEach(async () => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  hooks = new KernelHookHarness(state)
  vi.mocked(listRecords).mockResolvedValue(result())
  vi.mocked(listProviders).mockResolvedValue({
    items: [],
    modelConfigVersion: 2,
    storageDurable: true,
    selections: { image: null, vision: null },
  })
  const wrapper = SourceImageHistoryDialog({ source, onClose: vi.fn() })
  const Content = wrapper.type as (props: typeof wrapper.props) => ReactNode
  render = () => hooks.render(() => Content(wrapper.props))
  await settle()
  publishStatus({ pid: 100, running: 0, queued: 0, activeGenerations: 0 })
  await settle()
})

afterEach(() => {
  hooks.dispose()
  vi.useRealTimers()
})

describe('source batch retrieval', () => {
  it('keeps complete scene batches visible and opens their existing detail by parent ID', async () => {
    expect(components(render(), BatchSummary)).toHaveLength(1)
    expect(
      components(render(), BatchSummary)[0]?.props.record.scenePlan?.views,
    ).toHaveLength(3)
    button('查看详情').props.onClick?.({} as MouseEvent<HTMLButtonElement>)
    expect(components(render(), RecordDetailDialog)[0]?.props.recordId).toBe('record')
    expect(listRecords).toHaveBeenCalledExactlyOnceWith(
      0,
      10,
      undefined,
      { pluginId: source.pluginId, itemId: source.itemId },
      {},
    )
  })

  it('resets source batch pagination for search and ignores a stale page response', async () => {
    const older = deferred<RecordPage>()
    vi.mocked(listRecords).mockReturnValueOnce(older.promise)
    button('下一页').props.onClick?.({} as MouseEvent<HTMLButtonElement>)
    await settle()
    const input = components(render(), Input).find(
      (node) => node.props['aria-label'] === '搜索商品生图批次',
    )
    expect(input).toBeDefined()
    input!.props.onChange?.({
      target: { value: 'front' },
    } as ChangeEvent<HTMLInputElement>)
    const fresh = { ...makeSceneRecord(), id: 'fresh-batch' }
    vi.mocked(listRecords).mockResolvedValue(result({ items: [fresh], total: 1 }))
    await settle()
    expect(listRecords).toHaveBeenLastCalledWith(
      0,
      10,
      undefined,
      { pluginId: source.pluginId, itemId: source.itemId },
      { query: 'front' },
    )
    older.resolve(result({ items: [{ ...makeSceneRecord(), id: 'stale-batch' }] }))
    await flushPromises()
    expect(components(render(), BatchSummary)[0]?.props.record.id).toBe('fresh-batch')
    const kind = components(render(), LabeledSelect).find(
      (node) => node.props.ariaLabel === '商品生图任务类型',
    )
    expect(kind).toBeDefined()
    kind!.props.onValueChange('scene')
    await settle()
    expect(listRecords).toHaveBeenLastCalledWith(
      0,
      10,
      undefined,
      { pluginId: source.pluginId, itemId: source.itemId },
      { query: 'front', kind: 'scene' },
    )
  })
})

describe('source batch polling', () => {
  it.each(['running', 'queued', 'activeGenerations'])(
    'refreshes an empty single-image history while plugin %s is positive and stops when idle',
    async (counter) => {
      vi.mocked(listRecords).mockResolvedValue(result({ items: [], total: 0 }))
      components(render(), LabeledSelect)
        .find((node) => node.props.ariaLabel === '商品生图任务类型')!
        .props.onValueChange('single')
      await settle()
      publishStatus({ pid: 100, [counter]: 1 })
      await settle()
      expect(components(render(), BatchSummary)).toHaveLength(0)
      const reads = vi.mocked(listRecords).mock.calls.length
      const providers = vi.mocked(listProviders).mock.calls.length

      publishStatus({ pid: 100, [counter]: 2 })
      await settle()
      expect(listRecords).toHaveBeenCalledTimes(reads)
      expect(listProviders).toHaveBeenCalledTimes(providers)
      const single = {
        ...makeSceneRecord(),
        id: 'source-single',
        count: 1,
        status: 'running' as const,
        stage: 'image' as const,
        outputs: [],
        error: null,
      }
      delete single.scenePlan
      vi.mocked(listRecords).mockResolvedValue(
        result({
          items: [single],
          total: 1,
        }),
      )
      await vi.advanceTimersByTimeAsync(2500)
      await settle()

      expect(listRecords).toHaveBeenCalledTimes(reads + 1)
      expect(listRecords).toHaveBeenLastCalledWith(
        0,
        10,
        undefined,
        { pluginId: source.pluginId, itemId: source.itemId },
        { kind: 'single' },
      )
      expect(components(render(), BatchSummary)[0]?.props.record.id).toBe('source-single')

      vi.mocked(listRecords).mockResolvedValue(result({ items: [], total: 0 }))
      publishStatus({ pid: 100, running: 0, queued: 0, activeGenerations: 0 })
      await settle()
      const idleReads = vi.mocked(listRecords).mock.calls.length
      const idleProviders = vi.mocked(listProviders).mock.calls.length
      await vi.advanceTimersByTimeAsync(10_000)

      expect(listRecords).toHaveBeenCalledTimes(idleReads)
      expect(listProviders).toHaveBeenCalledTimes(idleProviders)
    },
  )

  it('does not repeat history or provider reads for idle catalog updates', async () => {
    vi.mocked(listRecords).mockResolvedValue(result({ items: [], total: 0 }))
    components(render(), LabeledSelect)
      .find((node) => node.props.ariaLabel === '商品生图任务类型')!
      .props.onValueChange('single')
    await settle()
    const reads = vi.mocked(listRecords).mock.calls.length
    const providers = vi.mocked(listProviders).mock.calls.length

    for (const status of [
      { pid: 100, running: 0, queued: 0, activeGenerations: 0 },
      { pid: 100, running: '1', queued: -1, activeGenerations: Number.NaN },
    ]) {
      publishStatus(status)
      await settle()
    }
    await vi.advanceTimersByTimeAsync(10_000)

    expect(listRecords).toHaveBeenCalledTimes(reads)
    expect(listProviders).toHaveBeenCalledTimes(providers)
  })
})
