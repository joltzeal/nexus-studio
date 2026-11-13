import type { DependencyList, EffectCallback, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import {
  components,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { listAgentTargets, type AgentTarget } from './api'
import {
  addDraftProducts,
  assignDraftProducts,
  emptyAgentDraft,
  setDraftWindows,
  type AgentDraft,
} from './assignment'
import { BatchComposer } from './batch-composer'
import { product, target } from './test-data'

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
  listAgentTargets: vi.fn(),
}))

function windowTarget(
  id: string,
  status: NonNullable<AgentTarget['account']>['status'] | null,
  overrides: Partial<AgentTarget> = {},
): AgentTarget {
  return {
    ...target,
    id,
    name: id,
    account: status ? { ...target.account!, id: `account-${id}`, status } : null,
    unavailable:
      status === 'blocked'
        ? '账号已封禁（blocked），禁止创建任务。'
        : status === null
          ? '账号未关联或资料不可见。'
          : null,
    ...overrides,
  }
}

describe('execution window account status filters', () => {
  let hooks: KernelHookHarness
  let draft: AgentDraft
  const render = (): ReactNode =>
    hooks.render(() =>
      BatchComposer({
        draft,
        setDraft: (next) => {
          draft = typeof next === 'function' ? next(draft) : next
        },
        accountsUnavailable: null,
        productsUnavailable: null,
        settingsUnavailable: null,
        onCreated: vi.fn(),
        onRuns: vi.fn(),
      }),
    )
  const settle = async () => {
    render()
    hooks.flushEffects()
    await flushPromises()
  }
  const select = (label: string, value: string) => {
    const control = components(render(), LabeledSelect).find(
      (node) => node.props.ariaLabel === label,
    )
    expect(control, `Missing select ${label}`).toBeDefined()
    expect(control!.props.options.some((option) => option.value === value)).toBe(true)
    control!.props.onValueChange(value)
  }
  const button = (label: string) =>
    components(render(), Button).find(
      (node) => node.props['aria-label'] === label || text(node.props.children) === label,
    )!
  const click = (label: string) =>
    button(label).props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
  const visibleWindows = () =>
    components(render(), Checkbox)
      .filter((node) => node.props['aria-label']?.startsWith('选择窗口 '))
      .map((node) => node.props['aria-label']!.replace('选择窗口 ', ''))
  const search = (value: string) =>
    components(render(), Input)
      .find((node) => node.props['aria-label'] === '搜索执行窗口')!
      .props.onChange?.({ target: { value } } as React.ChangeEvent<HTMLInputElement>)

  beforeEach(() => {
    vi.clearAllMocks()
    hooks = new KernelHookHarness(state)
    draft = { ...emptyAgentDraft(), preset: 'inspect_accounts' }
    vi.mocked(listAgentTargets).mockResolvedValue([
      windowTarget('Active', 'active'),
      windowTarget('Pending', 'pending'),
      windowTarget('Limited', 'limited'),
      windowTarget('Blocked', 'blocked'),
      windowTarget('Unlinked', null),
      windowTarget('Unknown browser', 'active', {
        state: 'unknown',
        unavailable: '窗口状态未知，请先核对。',
      }),
    ])
  })
  afterEach(() => hooks.dispose())

  it.each<[string, string[]]>([
    ['all', ['Active', 'Pending', 'Limited', 'Blocked', 'Unlinked', 'Unknown browser']],
    ['active', ['Active', 'Unknown browser']],
    ['pending', ['Pending']],
    ['limited', ['Limited']],
    ['blocked', ['Blocked']],
    ['unknown', ['Unlinked']],
  ])(
    'filters %s using account status independently of browser availability',
    async (status, expected) => {
      await settle()
      select('执行窗口账号状态筛选', status)
      expect(visibleWindows()).toEqual(expected)
      expect(draft.windowIds).toEqual([])
    },
  )

  it('filters the full list before pagination and resets the page when status or search changes', async () => {
    vi.mocked(listAgentTargets).mockResolvedValue(
      Array.from({ length: 45 }, (_, index) =>
        windowTarget(
          `Window ${String(index).padStart(2, '0')}`,
          index % 2 === 0 ? 'active' : 'blocked',
        ),
      ),
    )
    await settle()
    click('下一页执行窗口')
    expect(visibleWindows()[0]).toBe('Window 20')
    select('执行窗口账号状态筛选', 'blocked')
    expect(visibleWindows()).toHaveLength(20)
    expect(visibleWindows()[0]).toBe('Window 01')
    expect(text(render())).toContain('共 22 个 · 1 / 2')
    click('下一页执行窗口')
    expect(visibleWindows()).toEqual(['Window 41', 'Window 43'])
    search('window 4')
    expect(visibleWindows()).toEqual(['Window 41', 'Window 43'])
    expect(text(render())).toContain('共 2 个 · 1 / 1')
    search('no match')
    expect(text(render())).toContain('没有匹配窗口')
    expect(text(render())).toContain('共 0 个 · 1 / 1')
    expect(button('上一页执行窗口').props.disabled).toBe(true)
    expect(button('下一页执行窗口').props.disabled).toBe(true)
  })

  it('preserves assignments, messages and selections across combined filters and page bulk selection', async () => {
    const rows = Array.from({ length: 25 }, (_, index) =>
      windowTarget(`Window ${index}`, index === 1 ? 'blocked' : 'active'),
    )
    vi.mocked(listAgentTargets).mockResolvedValue(rows)
    draft = {
      ...assignDraftProducts(
        setDraftWindows(addDraftProducts(emptyAgentDraft(), [product]), ['Window 24']),
        [product.id],
        'Window 24',
      ),
      messages: { 'Window 24': { conversationId: '123', text: 'Hello.' } },
    }
    await settle()
    select('执行窗口账号状态筛选', 'active')
    click('选择本页可用窗口')
    expect(draft.windowIds).toHaveLength(21)
    expect(draft.windowIds).not.toContain('Window 1')
    expect(draft.windowIds).toContain('Window 24')
    click('下一页执行窗口')
    expect(visibleWindows()).toEqual(['Window 21', 'Window 22', 'Window 23', 'Window 24'])
    click('选择本页可用窗口')
    expect(draft.windowIds).toHaveLength(24)
    const selectedIds = [...draft.windowIds]
    select('执行窗口账号状态筛选', 'blocked')
    expect(visibleWindows()).toEqual(['Window 1'])
    expect(button('选择本页可用窗口').props.disabled).toBe(true)
    select('执行窗口筛选', 'selected')
    expect(visibleWindows()).toEqual([])
    select('执行窗口账号状态筛选', 'active')
    expect(visibleWindows()).toHaveLength(20)
    search('Window 24')
    expect(visibleWindows()).toEqual(['Window 24'])
    select('每页执行窗口数', '50')
    expect(draft.windowIds).toEqual(selectedIds)
    expect(draft.assignments).toEqual({ [product.id]: 'Window 24' })
    expect(draft.messages).toEqual({
      'Window 24': { conversationId: '123', text: 'Hello.' },
    })
  })

  it('keeps a newly blocked selected window visible without enabling assignment or dispatch', async () => {
    const blocked = windowTarget('Blocked', 'blocked')
    vi.mocked(listAgentTargets).mockResolvedValue([windowTarget('Blocked', 'active')])
    draft = assignDraftProducts(
      setDraftWindows(addDraftProducts(emptyAgentDraft(), [product]), [blocked.id]),
      [product.id],
      blocked.id,
    )
    await settle()
    vi.mocked(listAgentTargets).mockResolvedValue([
      blocked,
      windowTarget('Other blocked', 'blocked'),
    ])
    click('刷新窗口')
    await settle()
    select('执行窗口账号状态筛选', 'blocked')
    expect(visibleWindows()).toEqual(['Blocked', 'Other blocked'])
    components(render(), Checkbox)
      .find((node) => node.props['aria-label'] === `勾选 ${product.name}`)!
      .props.onCheckedChange?.(true)
    expect(button('分配到 Blocked').props.disabled).toBe(true)
    expect(button('选择本页可用窗口').props.disabled).toBe(true)
    expect(button('检查并创建批次').props.disabled).toBe(true)
    expect(
      components(render(), Checkbox).find(
        (node) => node.props['aria-label'] === '选择窗口 Other blocked',
      )!.props.disabled,
    ).toBe(true)
    const card = elements(render()).find(
      (node) => node.type === 'article' && node.props['data-blocked'] === true,
    )!
    const drop = card.props.onDrop as React.DragEventHandler
    drop({
      preventDefault: vi.fn(),
      dataTransfer: { getData: () => JSON.stringify([product.id]) },
    } as unknown as React.DragEvent)
    select('执行窗口账号状态筛选', 'active')
    expect(visibleWindows()).toEqual([])
    expect(draft.windowIds).toEqual(['Blocked'])
    expect(draft.assignments).toEqual({ [product.id]: 'Blocked' })
  })
})
