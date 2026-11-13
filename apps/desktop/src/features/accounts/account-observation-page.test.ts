import {
  type DependencyList,
  type EffectCallback,
  type FormEvent,
  type MouseEvent,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness,
} from '@/features/settings/kernel-test-support'
import { consumeDetailNavigation, navigateDetail } from '@/lib/detail-navigation'
import type { PluginView } from '@/lib/platform/native-plugins'
import { AccountEditor } from './account-editor'
import { listAccounts, saveAccount } from './api'
import { AccountsPage } from './accounts-page'
import { accountObservation, observedAccount } from './account-observation-test-support'
import type { Account } from './types'

const state = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
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
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  listAccounts: vi.fn(),
  saveAccount: vi.fn(),
}))
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const plugin: PluginView = {
  id: 'studio.vinted-accounts',
  name: 'Vinted 账号池',
  version: '1.3.0',
  apiVersion: 1,
  minCoreVersion: '0.1.28',
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
  status: { storage: 'file' },
  lastError: null,
  storageDurable: true,
  secretSlots: [],
  sourceDirectory: null,
}

let hooks: KernelHookHarness
const tree = () => hooks.render(() => AccountsPage({ plugin, hostAvailable: true }))

async function mount(item: Account) {
  vi.mocked(listAccounts).mockResolvedValue({
    items: [item],
    total: 1,
    bindings: [],
    storageDurable: true,
  })
  tree()
  hooks.flushEffects()
  await flushPromises()
}

beforeEach(() => {
  vi.resetAllMocks()
  hooks = new KernelHookHarness(state)
})
afterEach(() => {
  hooks.dispose()
  consumeDetailNavigation('account')
})

describe('account pool observation display', () => {
  it('opens the latest linked account and ignores a superseded detail read', async () => {
    const original = observedAccount()
    const replacement = observedAccount({
      id: '18e7156f-3892-45ca-9acc-d30170c36fce',
      account: 'replacement@example.invalid',
    })
    await mount(original)
    const stale = deferred<Awaited<ReturnType<typeof listAccounts>>>()
    vi.mocked(listAccounts).mockReturnValueOnce(stale.promise)
    navigateDetail({ kind: 'account', id: original.id })
    tree()
    hooks.flushEffects()
    vi.mocked(listAccounts).mockResolvedValue({
      items: [replacement],
      total: 1,
      bindings: [],
      storageDurable: true,
    })
    navigateDetail({ kind: 'account', id: replacement.id })
    tree()
    hooks.flushEffects()
    await flushPromises()

    expect(components(tree(), AccountEditor)[0]?.props.account).toEqual(replacement)
    stale.resolve({
      items: [original],
      total: 1,
      bindings: [],
      storageDurable: true,
    })
    await flushPromises()
    expect(components(tree(), AccountEditor)[0]?.props.account).toEqual(replacement)
    expect(saveAccount).not.toHaveBeenCalled()
  })

  it('shows stored account metadata and one balance column alongside the user note', async () => {
    await mount(observedAccount())

    const html = renderToStaticMarkup(tree())

    expect(html).toContain('已验证')
    expect(html).toContain('活跃卖家')
    expect(html).toContain('近期有成交，资料完整。')
    expect(html).toContain('评分 4.8/5')
    expect(html).toContain('用户备注保留')
    expect(html).toContain('123456789012.3400')
    expect(html).toContain('0.00')
    expect(html).toContain('EUR')
    expect(html.match(/<th\b[^>]*>余额<\/th>/g)).toHaveLength(1)
    expect(html).toContain('查看 seller@example.test 的余额来源与时间')
    expect(html).not.toContain('synthetic password')
  })

  it('renders unknown amounts as a dash and keeps a zero rating visible', async () => {
    const observation = accountObservation()
    await mount(
      observedAccount({
        observation: {
          ...observation,
          tags: [],
          summary: '',
          rating: 0,
          balance: {
            currency: 'GBP',
            available: null,
            pending: null,
            availableEvidence: null,
            pendingEvidence: null,
          },
        },
      }),
    )

    const html = renderToStaticMarkup(tree())

    expect(html).toContain('评分 0/5')
    expect(html).toContain('GBP')
    expect(html).toContain('可用')
    expect(html).toContain('待结算')
    expect(html).not.toContain('0.00')
    expect(html).not.toContain('123456789012.3400')
    expect(html).not.toContain('活跃卖家')
  })

  it('keeps observation-free account rows without inventing metadata or balance controls', async () => {
    const item = observedAccount()
    delete item.observation
    await mount(item)

    const html = renderToStaticMarkup(tree())

    expect(html).toContain('用户备注保留')
    expect(html).not.toContain('评分')
    expect(html).not.toContain('余额来源与时间')
    expect(html).not.toContain('已验证')
  })

  it('submits only editable fields when editing an observed account', async () => {
    const item = observedAccount()
    await mount(item)
    const edit = components(tree(), Button).find(
      (node) => node.props['aria-label'] === `编辑 ${item.account}`,
    )!
    edit.props.onClick?.({} as MouseEvent<HTMLButtonElement>)
    const editor = components(tree(), AccountEditor)[0]!
    const editorHooks = new KernelHookHarness(state)
    try {
      const formTree = editorHooks.render(() => AccountEditor(editor.props))
      expect(
        components(formTree, Input).some(
          (node) =>
            node.props.value === item.observation?.summary ||
            node.props.value === item.observation?.balance?.available,
        ),
      ).toBe(false)
      vi.mocked(saveAccount).mockResolvedValueOnce({ item, created: false })
      const form = elements(formTree).find((node) => node.type === 'form')!
      const submit = form.props.onSubmit as (event: FormEvent) => void
      submit({ preventDefault: vi.fn() } as unknown as FormEvent)
      await flushPromises()

      expect(saveAccount).toHaveBeenCalledWith({
        id: item.id,
        loginMethod: 'email',
        account: 'seller@example.test',
        password: ' synthetic password ',
        phone: '+33123456789',
        emailOtpUrl: 'https://example.test/mail',
        smsOtpUrl: 'https://example.test/sms',
        note: '用户备注保留',
        status: 'active',
        homepageUrl: 'https://www.vinted.fr/member/123456',
      })
      expect(components(tree(), AccountEditor)).toHaveLength(0)
    } finally {
      editorHooks.dispose()
    }
  })
})
