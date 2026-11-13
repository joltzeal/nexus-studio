import type { DependencyList, EffectCallback, ReactNode } from 'react'
import { AgentItemViewSchema, type AgentModelRequestPage } from '@nexus/plugin-sdk/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlertDialogAction } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  components,
  deferred,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import {
  cleanAgentRetention,
  controlAgentItem,
  getAgentWorkspace,
  listAgentModelRequests,
  previewAgentRetention,
  saveAgentWorkspace,
} from './api'
import { emptyAgentDraft } from './assignment'
import { AgentPagination } from './agent-pagination'
import { ItemReview } from './job-items'
import { RetentionDialog } from './retention-dialog'
import { ids, now, product } from './test-data'
import { WorkspaceLibrary } from './workspace-library'
import { ModelRequestHistory } from './usage-panel'

const state = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : react.useEffect(effect, deps),
  }
})
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  controlAgentItem: vi.fn(),
  previewAgentRetention: vi.fn(),
  cleanAgentRetention: vi.fn(),
  saveAgentWorkspace: vi.fn(),
  getAgentWorkspace: vi.fn(),
  listAgentModelRequests: vi.fn(),
}))

let hooks: KernelHookHarness
let view: () => ReactNode
const render = () => hooks.render(view)
const button = (label: string) =>
  components(render(), Button).find((node) => text(node.props.children) === label)!
const click = (label: string) =>
  button(label).props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)

beforeEach(() => {
  vi.clearAllMocks()
  hooks = new KernelHookHarness(state)
})
afterEach(() => hooks.dispose())

const item = AgentItemViewSchema.parse({
  jobId: ids.job,
  productId: ids.product,
  windowId: ids.window,
  windowName: 'Fixture',
  accountId: ids.account,
  state: 'review_required',
  originalTitle: 'Original cotton shirt',
  originalDescription: 'A used cotton shirt with a cuff mark.',
  title: 'Cotton shirt',
  description: 'Used cotton shirt with a small mark near the cuff.',
  submitted: false,
})

describe('item review receipt recovery', () => {
  const onSaved = vi.fn()
  const onReload = vi.fn()
  beforeEach(() => {
    view = () =>
      ItemReview({
        item,
        jobState: 'review_required',
        onSaved,
        onReload,
        onClose: vi.fn(),
      })
    render()
    hooks.flushEffects()
  })

  it('freezes all edits after a lost receipt and reads before another decision', async () => {
    vi.mocked(controlAgentItem).mockRejectedValue(new Error('Reply lost'))
    click('确认资料并继续')
    await flushPromises()
    expect(text(render())).toContain('不要重复操作')
    expect(button('确认资料并继续').props.disabled).toBe(true)
    expect(button('跳过此商品').props.disabled).toBe(true)
    click('确认资料并继续')
    expect(controlAgentItem).toHaveBeenCalledExactlyOnceWith({
      jobId: ids.job,
      productId: ids.product,
      action: 'approve',
    })
    expect(onSaved).not.toHaveBeenCalled()
    onReload.mockResolvedValue({ ...item, controlRevision: 1 })
    click('重新读取商品')
    await flushPromises()
    expect(onReload).toHaveBeenCalledOnce()
    expect(controlAgentItem).toHaveBeenCalledOnce()
  })

  it('does not claim save for a receipt older than the displayed item revision', async () => {
    view = () =>
      ItemReview({
        item: { ...item, controlRevision: 3 },
        jobState: 'review_required',
        onSaved,
        onReload,
        onClose: vi.fn(),
      })
    vi.mocked(controlAgentItem).mockResolvedValue({
      revision: 2,
      items: [{ productId: ids.product, action: 'approve', revision: 2 }],
    })
    click('确认资料并继续')
    await flushPromises()
    expect(onSaved).not.toHaveBeenCalled()
    expect(text(render())).toContain('修订未确认')
    expect(button('确认资料并继续').props.disabled).toBe(true)
  })

  it('keeps cancelled job items read-only and ignores late success after closing', async () => {
    view = () =>
      ItemReview({
        item,
        jobState: 'cancelled',
        onSaved,
        onReload,
        onClose: vi.fn(),
      })
    expect(button('确认资料并继续').props.disabled).toBe(true)
    click('确认资料并继续')
    expect(controlAgentItem).not.toHaveBeenCalled()
    view = () =>
      ItemReview({
        item,
        jobState: 'review_required',
        onSaved,
        onReload,
        onClose: vi.fn(),
      })
    const late = deferred<Awaited<ReturnType<typeof controlAgentItem>>>()
    vi.mocked(controlAgentItem).mockReturnValue(late.promise)
    click('确认资料并继续')
    hooks.dispose()
    late.resolve({
      revision: 1,
      items: [{ productId: ids.product, action: 'approve', revision: 1 }],
    })
    await flushPromises()
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe('retention preview and confirmation', () => {
  const onCleaned = vi.fn()
  const preview = {
    token: 'fixture-one-use-token',
    before: now,
    batches: 2,
    protected: 3,
    artifactBytes: 1024,
  }
  const confirm = () =>
    components(render(), AlertDialogAction)[0]!.props.onClick?.({
      preventDefault() {},
    } as React.MouseEvent<HTMLButtonElement>)
  beforeEach(() => {
    view = () => RetentionDialog({ onClose: vi.fn(), onCleaned })
    render()
    hooks.flushEffects()
    vi.mocked(previewAgentRetention).mockResolvedValue(preview)
  })

  it('requires a fresh preview and discards its token when retention days change', async () => {
    confirm()
    expect(cleanAgentRetention).not.toHaveBeenCalled()
    click('预览可清理任务')
    await flushPromises()
    expect(text(render())).toContain('受保护批次')
    components(render(), Input)[0]!.props.onChange?.({
      target: { valueAsNumber: 45 },
    } as React.ChangeEvent<HTMLInputElement>)
    confirm()
    expect(cleanAgentRetention).not.toHaveBeenCalled()
    expect(button('清理预览中的任务')).toBeUndefined()
  })

  it('invalidates an uncertain clean token and never repeats the destructive request', async () => {
    vi.mocked(cleanAgentRetention).mockRejectedValue(new Error('Reply lost'))
    click('预览可清理任务')
    await flushPromises()
    click('清理预览中的任务')
    confirm()
    await flushPromises()
    expect(cleanAgentRetention).toHaveBeenCalledExactlyOnceWith(preview.token)
    expect(onCleaned).not.toHaveBeenCalled()
    expect(text(render())).toContain('请重新预览后核对')
    confirm()
    expect(cleanAgentRetention).toHaveBeenCalledOnce()
    expect(button('清理预览中的任务')).toBeUndefined()
  })

  it('ignores a preview arriving after the dialog session closes', async () => {
    const late = deferred<typeof preview>()
    vi.mocked(previewAgentRetention).mockReturnValue(late.promise)
    click('预览可清理任务')
    hooks.dispose()
    late.resolve(preview)
    await flushPromises()
    expect(cleanAgentRetention).not.toHaveBeenCalled()
    expect(onCleaned).not.toHaveBeenCalled()
  })
})

describe('workspace revision conflict recovery', () => {
  it('preserves edits saved before assignment while recovering one lost draft receipt', async () => {
    const draft = {
      ...emptyAgentDraft(),
      products: [product],
      overrides: { [ids.product]: { productId: ids.product, title: 'Edited mug' } },
    }
    const onLoaded = vi.fn()
    view = () =>
      WorkspaceLibrary({
        draft,
        locked: false,
        onLoaded,
        onLockChange: vi.fn(),
      })
    render()
    hooks.flushEffects()
    components(render(), Input)[0]!.props.onChange?.({
      target: { value: 'Before assignment' },
    } as React.ChangeEvent<HTMLInputElement>)
    vi.mocked(saveAgentWorkspace).mockRejectedValue(new Error('Reply lost'))
    click('另存为新草稿')
    await flushPromises()
    expect(text(render())).toContain('保存未确认')
    expect(button('另存为新草稿').props.disabled).toBe(true)
    expect(saveAgentWorkspace).toHaveBeenCalledOnce()
    const input = vi.mocked(saveAgentWorkspace).mock.calls[0]![0]
    expect(input.data.assignments).toEqual([])
    expect(input.data.unassignedOverrides).toEqual([
      { productId: ids.product, title: 'Edited mug' },
    ])
    vi.mocked(getAgentWorkspace).mockResolvedValue({
      id: input.id,
      kind: input.kind,
      name: input.name,
      data: input.data,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    click('读取原保存结果')
    await flushPromises()
    expect(text(render())).toContain('草稿已保存')
    expect(button('另存为新草稿').props.disabled).toBe(false)
    expect(saveAgentWorkspace).toHaveBeenCalledOnce()
    expect(onLoaded).not.toHaveBeenCalled()
    expect(draft.overrides[ids.product]?.title).toBe('Edited mug')
  })

  it('preserves the form and requires loading or saving separately after a conflicting read', async () => {
    const draft = emptyAgentDraft()
    const onLoaded = vi.fn()
    view = () =>
      WorkspaceLibrary({
        draft,
        locked: false,
        onLoaded,
        onLockChange: vi.fn(),
      })
    render()
    hooks.flushEffects()
    components(render(), Input)[0]!.props.onChange?.({
      target: { value: 'My draft' },
    } as React.ChangeEvent<HTMLInputElement>)
    vi.mocked(saveAgentWorkspace).mockRejectedValue(new Error('Revision conflict'))
    click('另存为新草稿')
    await flushPromises()
    const input = vi.mocked(saveAgentWorkspace).mock.calls[0]![0]
    vi.mocked(getAgentWorkspace).mockResolvedValue({
      id: input.id,
      kind: input.kind,
      name: 'Updated elsewhere',
      data: { ...input.data, instruction: 'Another edit' },
      revision: 2,
      createdAt: now,
      updatedAt: now,
    })
    click('读取原保存结果')
    await flushPromises()
    expect(text(render())).toContain('修订已被其他操作更新')
    expect(components(render(), Input)[0]!.props.value).toBe('My draft')
    expect(button('更新已载入记录')).toBeUndefined()
    expect(button('另存为新草稿').props.disabled).toBe(false)
    expect(onLoaded).not.toHaveBeenCalled()
    expect(saveAgentWorkspace).toHaveBeenCalledOnce()
  })
})

describe('paginated model request history', () => {
  const page: AgentModelRequestPage = {
    batchId: ids.batch,
    items: [
      {
        requestId: ids.operation,
        jobId: ids.job,
        kind: 'generation',
        state: 'unknown',
        startedAt: now,
        elapsedMs: 5000,
        inputTokens: null,
        outputTokens: 0,
        estimatedCostUsd: null,
        status: null,
      },
      {
        requestId: ids.image,
        jobId: ids.job,
        kind: 'decision',
        state: 'succeeded',
        startedAt: now,
        elapsedMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        status: 200,
      },
    ],
    total: 21,
    page: 1,
    pageSize: 20,
  }
  beforeEach(() => {
    view = () => ModelRequestHistory({ id: ids.batch, revision: 0 })
  })

  it('distinguishes unknown receipts, nullable usage and a real zero cost', async () => {
    vi.mocked(listAgentModelRequests).mockResolvedValue(page)
    render()
    hooks.flushEffects()
    await flushPromises()
    expect(text(render())).toContain('回执未知')
    expect(text(render())).toContain('输入 未知 · 输出 0')
    expect(text(render())).toContain('费用未知')
    expect(text(render())).toContain('USD 0.0000')
    expect(text(render())).not.toContain('结束时间')
    expect(listAgentModelRequests).toHaveBeenCalledExactlyOnceWith(ids.batch, 1, 20)
    expect(components(render(), AgentPagination)[0]!.props.total).toBe(21)
  })

  it('does not replace a selected page with a late previous-page response', async () => {
    const oldPage = deferred<AgentModelRequestPage>()
    vi.mocked(listAgentModelRequests)
      .mockResolvedValueOnce(page)
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({
        ...page,
        items: [{ ...page.items[0]!, state: 'cancelled' }],
      })
    render()
    hooks.flushEffects()
    await flushPromises()
    const pagination = components(render(), AgentPagination)[0]!.props
    pagination.onPage(2)
    render()
    hooks.flushEffects()
    pagination.onPage(1)
    render()
    hooks.flushEffects()
    await flushPromises()
    expect(text(render())).toContain('已取消')
    oldPage.resolve({ ...page, page: 2 })
    await flushPromises()
    expect(text(render())).toContain('已取消')
    expect(text(render())).not.toContain('回执未知')
    expect(components(render(), AgentPagination)[0]!.props.page).toBe(1)
    expect(listAgentModelRequests).toHaveBeenLastCalledWith(ids.batch, 1, 20)
  })
})
