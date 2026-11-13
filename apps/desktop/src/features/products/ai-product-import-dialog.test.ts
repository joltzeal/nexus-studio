import type { DependencyList, EffectCallback } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductSchema } from '@nexus/plugin-products/contracts'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog } from '@/components/ui/dialog'
import { listRecords } from '@/features/ai-image/api'
import { makeSceneRecord } from '@/features/ai-image/scene-plan.test-data'
import {
  components,
  deferred,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { importGenerationProduct } from './ai-import'
import { AiProductImportDialog } from './ai-product-import-dialog'

const state = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useRef: (initial: unknown) =>
      state.hooks
        ? state.hooks.state(() => ({ current: initial }))[0]
        : react.useRef(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : react.useEffect(effect, deps),
  }
})
vi.mock('@/features/ai-image/api', () => ({ listRecords: vi.fn() }))
vi.mock('./ai-import', () => ({ importGenerationProduct: vi.fn() }))

const record = {
  ...makeSceneRecord(),
  id: 'complete-record',
  title: 'Completed group',
  status: 'success' as const,
  outputs: [{ id: 'output', name: 'output.png', mime: 'image/png', bytes: 1 }],
}
const product = ProductSchema.parse({
  id: '741204de-e426-4a97-9d1a-a8b420e6eac4',
  name: 'Imported group',
  revision: 1,
  sequence: 1,
  images: [],
  publicationCount: 0,
  latestPublication: null,
  source: { kind: 'ai-image', recordId: record.id, origin: null },
  createdAt: '2026-11-13T00:00:00.000Z',
  updatedAt: '2026-11-13T00:00:00.000Z',
})
let hooks: KernelHookHarness
let props: Parameters<typeof AiProductImportDialog>[0]
const render = () => hooks.render(() => AiProductImportDialog(props))
async function settle() {
  render()
  hooks.flushEffects()
  await flushPromises()
}
function selectAll() {
  components(render(), Checkbox)
    .find((node) => node.props['aria-label'] === '选择当前页可导入记录')!
    .props.onCheckedChange?.(true)
}
function start() {
  components(render(), Button)
    .find((node) => text(node.props.children).startsWith('导入所选'))!
    .props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
}

beforeEach(() => {
  vi.resetAllMocks()
  hooks = new KernelHookHarness(state)
  props = { unavailable: null, onClose: vi.fn(), onImported: vi.fn() }
  vi.mocked(listRecords).mockResolvedValue({
    items: [record],
    total: 1,
    page: 0,
    pageSize: 10,
    storageDurable: true,
  })
})
afterEach(() => hooks.dispose())

describe('AI product group imports', () => {
  it('does not query histories when AI is unavailable', async () => {
    props.unavailable = 'AI 插件未运行'
    await settle()
    expect(listRecords).not.toHaveBeenCalled()
    expect(importGenerationProduct).not.toHaveBeenCalled()
    expect(text(render())).toContain('AI 插件未运行')
  })

  it('reports copy progress and a failure for each record, keeping the dialog open', async () => {
    const other = { ...record, id: 'failed-group', title: 'Failed group' }
    vi.mocked(listRecords).mockResolvedValue({
      items: [record, other],
      total: 2,
      page: 0,
      pageSize: 10,
      storageDurable: true,
    })
    await settle()
    selectAll()
    const completed = deferred<{ product: typeof product; alreadyImported: boolean }>()
    vi.mocked(importGenerationProduct)
      .mockImplementationOnce((_id, options) => {
        options?.onProgress?.({ stage: 'copying', completed: 1, total: 2 })
        return completed.promise
      })
      .mockRejectedValueOnce(new Error('第二组成片读取失败'))
    start()
    await flushPromises()

    expect(text(render())).toContain('正在复制图片 1 / 2')
    components(render(), Dialog)[0]!.props.onOpenChange?.(false)
    expect(props.onClose).not.toHaveBeenCalled()
    completed.resolve({ product, alreadyImported: true })
    await flushPromises()

    const descriptions = components(render(), AlertDescription).map((node) =>
      text(node.props.children),
    )
    expect(descriptions).toContain('已导入过，保留现有商品')
    expect(descriptions).toContain('第二组成片读取失败')
    expect(
      components(render(), Alert).some((node) => node.props.variant === 'destructive'),
    ).toBe(true)
    expect(props.onImported).toHaveBeenCalledOnce()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(vi.mocked(importGenerationProduct).mock.calls.map(([id]) => id)).toEqual([
      record.id,
      other.id,
    ])
  })

  it('prevents choosing records without finished images or with recognition still running', async () => {
    vi.mocked(listRecords).mockResolvedValue({
      items: [
        { ...record, id: 'empty', title: 'Empty', outputs: [] },
        {
          ...record,
          id: 'vision',
          title: 'Recognizing',
          outputVision: { status: 'running' },
        },
      ],
      total: 2,
      page: 0,
      pageSize: 10,
      storageDurable: true,
    })
    await settle()
    const choices = components(render(), Checkbox)
    expect(choices.every((node) => node.props.disabled)).toBe(true)
  })
})
