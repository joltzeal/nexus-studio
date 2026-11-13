import type { DependencyList, EffectCallback, ReactNode, SetStateAction } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { PluginGate } from '@/features/plugins/plugin-gate'
import { watchPluginCatalog } from '@/features/plugins/watch-plugin-catalog'
import type { PluginView } from '@/lib/platform/native-plugins'
import { AgentProductCover } from './product-cover'
import {
  components,
  deferred,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import {
  checkAgentPreflight,
  createAgentBatch,
  getAgentSettings,
  listAgentTargets,
  type AgentTarget,
} from './api'
import {
  assignDraftProducts,
  addDraftProducts,
  emptyAgentDraft,
  setDraftWindows,
  type AgentDraft,
} from './assignment'
import { BatchComposer } from './batch-composer'
import { SalesAgentPage, SalesAgentWorkspace } from './sales-agent-page'
import {
  agentDependencyPlugins,
  agentPlugin,
  batch,
  ids,
  product,
  settings,
  target,
} from './test-data'

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
  createAgentBatch: vi.fn(),
  checkAgentPreflight: vi.fn(),
  getAgentSettings: vi.fn(),
  listAgentTargets: vi.fn(),
}))
vi.mock('@/features/plugins/watch-plugin-catalog', () => ({
  watchPluginCatalog: vi.fn(),
}))

describe('installed Agent gate', () => {
  it.each([
    { hostAvailable: false, plugin: agentPlugin() },
    { hostAvailable: true, plugin: null },
    { hostAvailable: true, plugin: agentPlugin({ state: 'available' }) },
    { hostAvailable: true, plugin: agentPlugin({ state: 'retrying' }) },
  ])('does not mount writable UI without the installed host and process', (props) => {
    const tree = SalesAgentPage(props)
    expect(components(tree, PluginGate)).toHaveLength(1)
    expect(components(tree, SalesAgentWorkspace)).toHaveLength(0)
  })

  it.each([
    { granted: [] },
    { methods: [] },
    { enabled: false },
    { storageDurable: false },
  ])('blocks incompatible or unauthorized plugins: %j', (overrides) => {
    const tree = SalesAgentPage({ hostAvailable: true, plugin: agentPlugin(overrides) })
    expect(components(tree, SalesAgentWorkspace)).toHaveLength(0)
    expect(text(tree)).toContain('不可用')
  })

  it('invalidates sessions on process replacement while ordinary status updates retain them', () => {
    const key = (pid: number, extra = {}) =>
      components(
        SalesAgentPage({
          hostAvailable: true,
          plugin: agentPlugin({ status: { pid, ...extra } }),
        }),
        SalesAgentWorkspace,
      )[0]!.key
    expect(key(1, { count: 3 })).toBe(key(1))
    expect(key(2)).not.toBe(key(1))
  })
})

describe('Agent dependency compatibility', () => {
  let hooks: KernelHookHarness
  let composerHooks: KernelHookHarness
  let catalog: PluginView[]
  let publishCatalog: (plugins: PluginView[]) => void
  const render = () => hooks.render(SalesAgentWorkspace)
  const composerProps = () => components(render(), BatchComposer)[0]!.props
  const renderComposer = () =>
    composerHooks.render(() =>
      BatchComposer({
        ...composerProps(),
        draft: assignDraftProducts(
          setDraftWindows(addDraftProducts(emptyAgentDraft(), [product]), [ids.window]),
          [ids.product],
          ids.window,
        ),
      }),
    )
  const settleComposer = async () => {
    renderComposer()
    composerHooks.flushEffects()
    await flushPromises()
    return renderComposer()
  }
  const createButton = (tree: ReactNode) =>
    components(tree, Button).find(
      (node) => text(node.props.children) === '检查并创建批次',
    )!

  beforeEach(async () => {
    vi.clearAllMocks()
    hooks = new KernelHookHarness(state)
    composerHooks = new KernelHookHarness(state)
    catalog = agentDependencyPlugins()
    vi.mocked(getAgentSettings).mockResolvedValue(settings)
    vi.mocked(listAgentTargets).mockResolvedValue([target])
    vi.mocked(watchPluginCatalog).mockImplementation((onCatalog) => {
      publishCatalog = onCatalog
      onCatalog(catalog)
      return vi.fn()
    })
    render()
    hooks.flushEffects()
    await flushPromises()
  })
  afterEach(() => {
    hooks.dispose()
    composerHooks.dispose()
  })

  it('allows creation when read, account snapshot, observation and publication methods exist', async () => {
    expect(composerProps()).toMatchObject({
      accountsUnavailable: null,
      productsUnavailable: null,
      settingsUnavailable: null,
    })
    expect(createButton(await settleComposer()).props.disabled).toBe(false)
  })

  it.each([
    ['studio.vinted-accounts', 'vinted.accounts.bindings', 'accountsUnavailable'],
    ['studio.vinted-accounts', 'vinted.accounts.agent.snapshot', 'accountsUnavailable'],
    [
      'studio.vinted-accounts',
      'vinted.accounts.observations.record',
      'accountsUnavailable',
    ],
    ['studio.products', 'products.list', 'productsUnavailable'],
    ['studio.products', 'products.get', 'productsUnavailable'],
    ['studio.products', 'products.images.read', 'productsUnavailable'],
    ['studio.products', 'products.publications.record', 'productsUnavailable'],
  ] as const)('blocks create before IPC when %s lacks %s', async (id, method, field) => {
    publishCatalog(
      catalog.map((plugin) =>
        plugin.id === id
          ? { ...plugin, methods: plugin.methods.filter((value) => value !== method) }
          : plugin,
      ),
    )
    expect(composerProps()[field]).toContain('插件需要更新')
    const tree = await settleComposer()
    expect(createButton(tree).props.disabled).toBe(true)
    expect(text(tree)).toContain('插件需要更新')
    components(tree, Button)
      .find((node) => text(node.props.children) === '确认并创建')!
      .props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
    await flushPromises()
    expect(createAgentBatch).not.toHaveBeenCalled()
    publishCatalog(catalog)
    expect(createButton(await settleComposer()).props.disabled).toBe(false)
  })
})

describe('real data assignment and submission UI', () => {
  let hooks: KernelHookHarness
  let draft: AgentDraft
  let accountsUnavailable: string | null
  const onCreated = vi.fn()
  const render = (): ReactNode =>
    hooks.render(() =>
      BatchComposer({
        draft,
        setDraft: (next: SetStateAction<AgentDraft>) => {
          draft = typeof next === 'function' ? next(draft) : next
        },
        accountsUnavailable,
        productsUnavailable: null,
        settingsUnavailable: null,
        onCreated,
        onRuns: vi.fn(),
      }),
    )
  const button = (label: string) => {
    const match = components(render(), Button).find(
      (node) => text(node.props.children) === label,
    )
    expect(match, `Missing button ${label}`).toBeDefined()
    return match!
  }
  const click = (label: string) =>
    button(label).props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
  const settle = async () => {
    render()
    hooks.flushEffects()
    await flushPromises()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    hooks = new KernelHookHarness(state)
    accountsUnavailable = null
    draft = assignDraftProducts(
      setDraftWindows(addDraftProducts(emptyAgentDraft(), [product]), [ids.window]),
      [ids.product],
      ids.window,
    )
    vi.mocked(listAgentTargets).mockResolvedValue([target])
    vi.mocked(createAgentBatch).mockResolvedValue(batch)
    vi.mocked(checkAgentPreflight).mockResolvedValue({
      ready: true,
      checkedAt: '2026-11-13T00:00:00Z',
      checks: [],
    })
  })
  afterEach(() => hooks.dispose())

  it('shows the actual first image on both product and assigned-window cards', async () => {
    await settle()
    const previews = components(render(), AgentProductCover)
    expect(previews).toHaveLength(2)
    expect(previews.map((node) => node.props.image.id)).toEqual([
      product.images[0]!.id,
      product.images[0]!.id,
    ])
    expect(text(render())).toContain(target.account!.account)
  })

  it('keeps window selection through search and pagination, supporting a real 100-window list', async () => {
    const targets = Array.from({ length: 100 }, (_, index) => ({
      ...target,
      id: `window-${index}`,
      name: `Real window ${index}`,
    }))
    vi.mocked(listAgentTargets).mockResolvedValue(targets)
    draft = { ...emptyAgentDraft(), preset: 'inspect_accounts' }
    await settle()
    expect(
      components(render(), Checkbox).filter((node) =>
        String(node.props['aria-label']).startsWith('选择窗口'),
      ),
    ).toHaveLength(20)
    click('选择本页可用窗口')
    expect(draft.windowIds).toHaveLength(20)
    const next = components(render(), Button).find(
      (node) => node.props['aria-label'] === '下一页执行窗口',
    )!
    next.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
    click('选择本页可用窗口')
    expect(draft.windowIds).toHaveLength(40)
    const search = components(render(), Input).find(
      (node) => node.props['aria-label'] === '搜索执行窗口',
    )!
    search.props.onChange?.({
      target: { value: 'Real window 99' },
    } as React.ChangeEvent<HTMLInputElement>)
    expect(draft.windowIds).toHaveLength(40)
    components(render(), LabeledSelect)
      .find((node) => node.props.ariaLabel === '每页执行窗口数')!
      .props.onValueChange('100')
    expect(text(render())).toContain('Real window 99')
    expect(
      components(render(), Checkbox)
        .filter((node) => String(node.props['aria-label']).startsWith('选择窗口'))
        .map((node) => node.props['aria-label']),
    ).toEqual(['选择窗口 Real window 99'])
  })

  it('supports keyboard/button assignment, unassignment, and preserves products after removing a window', async () => {
    draft = { ...draft, assignments: {} }
    await settle()
    components(render(), Checkbox)
      .find((node) => node.props['aria-label'] === `勾选 ${product.name}`)!
      .props.onCheckedChange?.(true)
    const assign = components(render(), Button).find(
      (node) => node.props['aria-label'] === `分配到 ${target.name}`,
    )!
    assign.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
    expect(draft.assignments).toEqual({ [product.id]: ids.window })
    components(render(), Checkbox)
      .find((node) => node.props['aria-label'] === `选择窗口 ${target.name}`)!
      .props.onCheckedChange?.(false)
    expect(draft.assignments).toEqual({})
    expect(draft.products).toEqual([product])
  })

  it('blocks create visibly for a banned account and rechecks a newly banned account before IPC', async () => {
    vi.mocked(listAgentTargets).mockResolvedValue([
      {
        ...target,
        unavailable: '账号已封禁（blocked）',
        account: { ...target.account!, status: 'blocked' },
      },
    ])
    await settle()
    expect(text(render())).toContain('blocked')
    expect(button('检查并创建批次').props.disabled).toBe(true)
    hooks.dispose()
    hooks = new KernelHookHarness(state)
    vi.mocked(listAgentTargets)
      .mockResolvedValueOnce([target])
      .mockResolvedValue([{ ...target, unavailable: '账号已封禁（blocked）' }])
    await settle()
    click('检查并创建批次')
    click('确认并创建')
    await flushPromises()
    expect(createAgentBatch).not.toHaveBeenCalled()
    expect(text(render())).toContain('blocked')
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('keeps a stable operationId when the create reply is lost and manually retried', async () => {
    vi.mocked(createAgentBatch)
      .mockRejectedValueOnce(new Error('Reply lost'))
      .mockResolvedValueOnce(batch)
    await settle()
    click('检查并创建批次')
    click('确认并创建')
    await flushPromises()
    const original = vi.mocked(createAgentBatch).mock.calls[0]![0]
    expect(text(render())).toContain('提交结果待核对')
    expect(onCreated).not.toHaveBeenCalled()
    expect(button('检查并创建批次').props.disabled).toBe(true)
    accountsUnavailable = 'Later source outage'
    vi.mocked(listAgentTargets).mockRejectedValue(new Error('Later source outage'))
    expect(button('核对原创建请求').props.disabled).toBe(false)
    click('核对原创建请求')
    await flushPromises()
    const retried = vi.mocked(createAgentBatch).mock.calls[1]![0]
    expect(retried).toEqual(original)
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(batch)
  })

  it('does not create when the final native preflight reports a changed source', async () => {
    vi.mocked(checkAgentPreflight).mockResolvedValue({
      ready: false,
      checkedAt: '2026-11-13T00:00:00Z',
      checks: [
        {
          code: 'published',
          productId: ids.product,
          severity: 'error',
          message: '商品已有发布记录',
          action: 'product',
        },
      ],
    })
    await settle()
    click('检查并创建批次')
    click('确认并创建')
    await flushPromises()
    expect(createAgentBatch).not.toHaveBeenCalled()
    expect(text(render())).toContain('运行前检查未通过')
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('ignores a late preflight after the installed session unmounts', async () => {
    const late = deferred<AgentTarget[]>()
    await settle()
    vi.mocked(listAgentTargets).mockReturnValueOnce(late.promise)
    click('检查并创建批次')
    click('确认并创建')
    hooks.dispose()
    late.resolve([target])
    await flushPromises()
    expect(createAgentBatch).not.toHaveBeenCalled()
  })
})
