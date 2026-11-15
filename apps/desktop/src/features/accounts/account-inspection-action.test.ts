import type { DependencyList, EffectCallback, MouseEvent } from 'react'
import type { AgentBatchView } from '@nexus/plugin-sdk/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { FieldError } from '@/components/ui/field'
import { toast } from '@/components/ui/toast'
import {
  components,
  deferred,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { consumeDetailNavigation } from '@/lib/detail-navigation'
import { invokeBrowser } from '@/lib/platform/browser-api'
import {
  callPlugin,
  pluginHostAvailable,
  type PluginView,
} from '@/lib/platform/native-plugins'
import { AccountInspectionAction } from './account-inspection-action'
import { AccountsPage } from './accounts-page'
import { listAccounts } from './api'
import { EMPTY_ACCOUNT, type Binding, type BindingView } from './types'

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
    useCallback: <T extends (...args: never[]) => unknown>(
      callback: T,
      deps: DependencyList,
    ) => (state.hooks ? callback : react.useCallback(callback, deps)),
  }
})
vi.mock('@/lib/platform/native-plugins', async (original) => ({
  ...(await original<typeof import('@/lib/platform/native-plugins')>()),
  callPlugin: vi.fn(),
  pluginHostAvailable: vi.fn(() => true),
}))
vi.mock('@/lib/platform/browser-api', async (original) => ({
  ...(await original<typeof import('@/lib/platform/browser-api')>()),
  invokeBrowser: vi.fn(),
}))
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  listAccounts: vi.fn(),
}))
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const accountId = '4198ca69-4f78-4705-ac59-2d48bc790194'
const windowId = '2198ca69-4f78-4705-ac59-2d48bc790194'
const secondWindowId = '8198ca69-4f78-4705-ac59-2d48bc790194'
const otherAccountId = '3198ca69-4f78-4705-ac59-2d48bc790194'
const now = '2026-11-14T00:00:00.000Z'
const binding: Binding = {
  accountId,
  windowId,
  revision: '7198ca69-4f78-4705-ac59-2d48bc790194',
  boundAt: now,
}
const boundAccount: BindingView['account'] = {
  id: accountId,
  account: 'fixture@example.invalid',
  loginMethod: 'email',
  status: 'blocked',
  note: '',
}
const batch: AgentBatchView = {
  id: '1198ca69-4f78-4705-ac59-2d48bc790194',
  preset: 'inspect_accounts',
  instruction: '',
  state: 'queued',
  concurrency: 1,
  total: 1,
  completed: 0,
  attention: 0,
  createdAt: now,
  updatedAt: now,
}

let hooks: KernelHookHarness
let props: Parameters<typeof AccountInspectionAction>[0]
const render = () => hooks.render(() => AccountInspectionAction(props))
const button = (label: string) =>
  components(render(), Button).find(
    (node) => node.props['aria-label'] === label || text(node.props.children) === label,
  )!
const click = (label: string) =>
  button(label).props.onClick?.({} as MouseEvent<HTMLButtonElement>)
const picker = () => components(render(), LabeledSelect)[0]!
const open = () => click('检查 fixture@example.invalid')

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(pluginHostAvailable).mockReturnValue(true)
  vi.mocked(callPlugin).mockResolvedValue({
    items: [{ ...binding, account: boundAccount }],
  })
  vi.mocked(invokeBrowser).mockResolvedValue(batch)
  props = {
    accountId,
    accountName: 'fixture@example.invalid',
    bindings: [binding],
  }
  hooks = new KernelHookHarness(state)
  consumeDetailNavigation('agent')
})

afterEach(() => {
  hooks.dispose()
  consumeDetailNavigation('agent')
})

describe('explicit account inspection', () => {
  it('makes no requests until confirmation and explains startup, queueing and read scope', () => {
    render()
    hooks.flushEffects()
    expect(callPlugin).not.toHaveBeenCalled()
    expect(invokeBrowser).not.toHaveBeenCalled()
    open()
    hooks.flushEffects()
    expect(components(render(), Dialog)[0]!.props.open).toBe(true)
    expect(text(components(render(), DialogTitle)[0]!.props.children)).toBe('检查账号')
    const explanation = text(components(render(), DialogDescription)[0]!.props.children)
    for (const label of [
      '启动',
      '排队',
      '只读',
      '状态',
      '主页',
      '余额',
      '收款',
      '画像',
    ]) {
      expect(explanation).toContain(label)
    }
    expect(callPlugin).not.toHaveBeenCalled()
    expect(invokeBrowser).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('offers only this account’s existing bindings and submits the selected blocked account for inspection', async () => {
    props.bindings = [
      binding,
      { ...binding, windowId: secondWindowId },
      { ...binding, windowId: batch.id, accountId: otherAccountId },
    ]
    vi.mocked(callPlugin).mockResolvedValue({
      items: [
        { ...binding, account: boundAccount },
        { ...binding, windowId: secondWindowId, account: boundAccount },
      ],
    })
    open()
    expect(picker().props.options.map((option) => option.value)).toEqual([
      windowId,
      secondWindowId,
    ])
    picker().props.onValueChange(secondWindowId)
    click('创建检查任务')
    await flushPromises()
    expect(callPlugin).toHaveBeenCalledExactlyOnceWith(
      'studio.vinted-accounts',
      'account.pool',
      'vinted.accounts.bindings',
      {},
    )
    expect(invokeBrowser).toHaveBeenCalledExactlyOnceWith('sales_agent_batch_create', {
      input: {
        operationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        preset: 'inspect_accounts',
        instruction: '',
        concurrency: 1,
        assignments: [
          { windowId: secondWindowId, productIds: [], overrides: [], messages: [] },
        ],
      },
    })
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(consumeDetailNavigation('agent')).toBeNull()
    click('查看任务')
    expect(consumeDetailNavigation('agent')).toEqual({
      kind: 'agent',
      id: batch.id,
      batchId: batch.id,
    })
    expect(listAccounts).not.toHaveBeenCalled()
  })

  it('explains missing bindings without inventing a window or submitting', async () => {
    props.bindings = [{ ...binding, accountId: otherAccountId }]
    open()
    expect(text(render())).toContain('尚未关联窗口')
    expect(button('创建检查任务').props.disabled).toBe(true)
    click('创建检查任务')
    await flushPromises()
    expect(callPlugin).not.toHaveBeenCalled()
    expect(invokeBrowser).not.toHaveBeenCalled()
  })

  it.each([
    ['removed', []],
    [
      'rebound to another account',
      [
        {
          ...binding,
          accountId: otherAccountId,
          account: { ...boundAccount, id: otherAccountId },
        },
      ],
    ],
    ['invisible account', [{ ...binding, account: null }]],
    [
      'changed revision',
      [{ ...binding, revision: otherAccountId, account: boundAccount }],
    ],
    [
      'duplicate window',
      [
        { ...binding, account: boundAccount },
        { ...binding, account: boundAccount },
      ],
    ],
  ])('blocks a %s binding on the fresh pre-submission read', async (_label, items) => {
    vi.mocked(callPlugin).mockResolvedValue({ items })
    open()
    click('创建检查任务')
    await flushPromises()
    expect(text(components(render(), FieldError)[0]!.props.children)).toContain('关联')
    expect(invokeBrowser).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('blocks a binding removed from current page data while the dialog is open', async () => {
    open()
    props.bindings = []
    click('创建检查任务')
    await flushPromises()
    expect(button('创建检查任务').props.disabled).toBe(true)
    expect(invokeBrowser).not.toHaveBeenCalled()
  })

  it('keeps binding read failures visible and permits an explicit retry', async () => {
    vi.mocked(callPlugin).mockRejectedValueOnce(new Error('Binding storage unavailable'))
    open()
    click('创建检查任务')
    await flushPromises()
    expect(text(render())).toContain('Binding storage unavailable')
    expect(invokeBrowser).not.toHaveBeenCalled()
    expect(button('创建检查任务').props.disabled).toBe(false)
    click('创建检查任务')
    await flushPromises()
    expect(invokeBrowser).toHaveBeenCalledTimes(1)
  })

  it.each([
    'Ecom Agent plugin is missing',
    'Ecom Agent plugin is disabled',
    'Account platform identity must be independently known',
  ])('shows the native rejection: %s', async (nativeMessage) => {
    vi.mocked(invokeBrowser).mockRejectedValueOnce(new Error(nativeMessage))
    open()
    click('创建检查任务')
    await flushPromises()
    expect(text(render())).toContain(nativeMessage)
    expect(toast.success).not.toHaveBeenCalled()
    expect(button('核对原创建请求').props.disabled).toBe(false)
  })

  it('retains the exact original request after an uncertain error and reopening', async () => {
    vi.mocked(invokeBrowser).mockRejectedValueOnce(new Error('Reply lost'))
    props.bindings = [binding, { ...binding, windowId: secondWindowId }]
    open()
    click('创建检查任务')
    await flushPromises()
    const original = vi.mocked(invokeBrowser).mock.calls[0]![1]
    expect(text(render())).toContain('创建结果未确认')
    expect(picker().props.disabled).toBe(true)
    picker().props.onValueChange(secondWindowId)
    components(render(), Dialog)[0]!.props.onOpenChange?.(false)
    open()
    click('核对原创建请求')
    await flushPromises()
    expect(invokeBrowser).toHaveBeenCalledTimes(2)
    expect(vi.mocked(invokeBrowser).mock.calls[1]![1]).toEqual(original)
    expect(toast.success).toHaveBeenCalledTimes(1)
  })

  it('retains the original operation if the submit handler runs again before rerendering', async () => {
    vi.mocked(invokeBrowser).mockRejectedValueOnce(new Error('Reply lost'))
    open()
    const submit = button('创建检查任务').props.onClick!
    submit({} as MouseEvent<HTMLButtonElement>)
    await flushPromises()
    const original = vi.mocked(invokeBrowser).mock.calls[0]![1]
    submit({} as MouseEvent<HTMLButtonElement>)
    await flushPromises()
    expect(invokeBrowser).toHaveBeenCalledTimes(2)
    expect(vi.mocked(invokeBrowser).mock.calls[1]![1]).toEqual(original)
  })

  it('stops before creating if the row unmounts during the binding read', async () => {
    const pending = deferred<unknown>()
    vi.mocked(callPlugin).mockReturnValueOnce(pending.promise)
    open()
    hooks.flushEffects()
    click('创建检查任务')
    hooks.dispose()
    pending.resolve({ items: [{ ...binding, account: boundAccount }] })
    await flushPromises()
    expect(invokeBrowser).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('ignores a late creation response after the row unmounts', async () => {
    const pending = deferred<unknown>()
    vi.mocked(invokeBrowser).mockReturnValueOnce(pending.promise)
    open()
    hooks.flushEffects()
    click('创建检查任务')
    await flushPromises()
    expect(invokeBrowser).toHaveBeenCalledTimes(1)
    hooks.dispose()
    pending.resolve(batch)
    await flushPromises()
    expect(toast.success).not.toHaveBeenCalled()
    expect(consumeDetailNavigation('agent')).toBeNull()
  })

  it('does not resend an uncertain request against a changed binding', async () => {
    vi.mocked(invokeBrowser).mockRejectedValueOnce(new Error('Reply lost'))
    open()
    click('创建检查任务')
    await flushPromises()
    vi.mocked(callPlugin).mockResolvedValue({
      items: [{ ...binding, revision: otherAccountId, account: boundAccount }],
    })
    click('核对原创建请求')
    await flushPromises()
    expect(invokeBrowser).toHaveBeenCalledTimes(1)
    expect(text(components(render(), FieldError)[0]!.props.children)).toContain('关联')
  })

  it('blocks synchronous duplicate submissions and closing while creation is pending', async () => {
    const pending = deferred<unknown>()
    vi.mocked(invokeBrowser).mockReturnValueOnce(pending.promise)
    open()
    const submit = button('创建检查任务').props.onClick!
    submit({} as MouseEvent<HTMLButtonElement>)
    submit({} as MouseEvent<HTMLButtonElement>)
    await flushPromises()
    expect(invokeBrowser).toHaveBeenCalledTimes(1)
    expect(picker().props.disabled).toBe(true)
    components(render(), Dialog)[0]!.props.onOpenChange?.(false)
    expect(components(render(), Dialog)[0]!.props.open).toBe(true)
    pending.resolve(batch)
    await flushPromises()
    expect(toast.success).toHaveBeenCalledTimes(1)
  })

  it('uses a new operation only after a confirmed batch and another explicit inspection', async () => {
    open()
    click('创建检查任务')
    await flushPromises()
    const original = vi.mocked(invokeBrowser).mock.calls[0]![1]
    components(render(), Dialog)[0]!.props.onOpenChange?.(false)
    open()
    click('创建检查任务')
    await flushPromises()
    expect(invokeBrowser).toHaveBeenCalledTimes(2)
    expect(vi.mocked(invokeBrowser).mock.calls[1]![1]).not.toEqual(original)
  })
})

describe('account row integration', () => {
  it('passes only the row identity and real bindings without changing the pool', async () => {
    const account = {
      ...EMPTY_ACCOUNT,
      id: accountId,
      account: boundAccount!.account,
      status: 'blocked' as const,
      password: 'synthetic-password-not-for-inspection',
      createdAt: now,
      updatedAt: now,
    }
    const data = { items: [account], total: 1, bindings: [binding], storageDurable: true }
    vi.mocked(listAccounts).mockResolvedValue(data)
    const plugin: PluginView = {
      id: 'studio.vinted-accounts',
      name: 'Vinted 账号池',
      version: '1.4.0',
      apiVersion: 1,
      minCoreVersion: '0.1.29',
      capabilities: ['account.pool'],
      granted: ['account.pool'],
      permissions: {
        networkDomains: [],
        wantsBrowserAccess: false,
        storage: 'private',
        secrets: [],
      },
      source: 'installed',
      state: 'running',
      enabled: true,
      methods: ['vinted.accounts.list'],
      status: null,
      lastError: null,
      storageDurable: true,
      secretSlots: [],
      sourceDirectory: null,
    }
    const page = () => hooks.render(() => AccountsPage({ plugin, hostAvailable: true }))
    page()
    hooks.flushEffects()
    await flushPromises()
    const actions = components(page(), AccountInspectionAction)
    expect(actions).toHaveLength(1)
    expect(actions[0]!.props).toEqual({
      accountId,
      accountName: boundAccount!.account,
      bindings: [binding],
    })
    expect(data.items).toEqual([account])
    expect(invokeBrowser).not.toHaveBeenCalled()
  })
})
