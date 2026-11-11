import {
  createElement,
  type ChangeEvent,
  type DependencyList,
  type EffectCallback,
  type FormEvent,
  type MouseEvent,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness as HookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { openExternalUrl } from '@/lib/platform/external-url'
import { callPlugin } from '@/lib/platform/native-plugins'
import type { PluginView } from '@/lib/platform/native-plugins'
import { AccountsPage } from './accounts-page'
import { OrderWatchPanel } from './order-watch-panel'

const state = vi.hoisted(() => ({ hooks: null as HookHarness | null }))
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
    ) => {
      if (!state.hooks) return react.useCallback(callback, deps)
      const [memo] = state.hooks.state(() => ({ callback, deps })) as [
        { callback: T; deps: DependencyList },
        unknown,
      ]
      if (
        memo.deps.length !== deps.length ||
        deps.some((value, index) => !Object.is(value, memo.deps[index]))
      ) {
        memo.callback = callback
        memo.deps = deps
      }
      return memo.callback
    },
  }
})
vi.mock('@/lib/platform/native-plugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-plugins')>()),
  callPlugin: vi.fn(),
}))
vi.mock('@/lib/platform/external-url', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/external-url')>()),
  openExternalUrl: vi.fn(),
}))

function plugin(overrides: Partial<PluginView> = {}): PluginView {
  return {
    id: 'studio.vinted-accounts',
    name: 'Vinted 账号池',
    version: '1.0.3',
    apiVersion: 1,
    minCoreVersion: '0.1.23',
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
    methods: ['vinted.accounts.list', 'vinted.accounts.orders.list'],
    status: { pid: 100 },
    lastError: null,
    storageDurable: true,
    secretSlots: [],
    sourceDirectory: null,
    ...overrides,
  }
}

describe('order watch entry', () => {
  it('offers 订单查询 when the running plugin advertises the method', () => {
    const html = renderToStaticMarkup(
      createElement(AccountsPage, { plugin: plugin(), hostAvailable: true }),
    )
    expect(html).toMatch(/<button[^>]*>.*?订单查询<\/button>/s)
  })

  it.each([
    { plugin: plugin({ methods: ['vinted.accounts.list'] }), hostAvailable: true },
    { plugin: plugin({ state: 'starting' }), hostAvailable: true },
    { plugin: plugin(), hostAvailable: false },
  ])('omits the entry for unavailable or older plugins: %j', (props) => {
    const html = renderToStaticMarkup(createElement(AccountsPage, props))
    expect(html).not.toContain('订单查询')
  })

  it('opens the panel only after the entry is clicked and supplies current labels', () => {
    const page = () =>
      hooks.render(() => AccountsPage({ plugin: plugin(), hostAvailable: true }))
    expect(calls('vinted.accounts.orders.list')).toHaveLength(0)
    components(page(), Button)
      .find((node) => text(node.props.children) === '订单查询')!
      .props.onClick?.({} as MouseEvent<HTMLButtonElement>)
    const panel = components(page(), OrderWatchPanel)[0]!
    expect(panel.props.open).toBe(true)
    expect(panel.props.plugin).toEqual(plugin())
    panel.props.onOpenChange(false)
    expect(components(page(), OrderWatchPanel)[0]!.props.open).toBe(false)
    expect(calls('vinted.accounts.orders.list')).toHaveLength(0)
  })
})

const METHODS = {
  settings: 'vinted.accounts.orders.settings.get',
  save: 'vinted.accounts.orders.settings.save',
  test: 'vinted.accounts.orders.bark.test',
  list: 'vinted.accounts.orders.list',
  run: 'vinted.accounts.orders.run',
  enabled: 'vinted.accounts.orders.enabled',
} as const

function settings(deviceKey = '') {
  return {
    intervalMinutes: 30,
    bark: { baseUrl: 'https://api.day.app', deviceKey, enabled: false },
  }
}

function candidate(status: 'pending' | 'sold' | 'reappeared' = 'pending') {
  return {
    id: `candidate-${status}`,
    itemId: `item-${status}`,
    itemUrl: `https://www.vinted.com/items/${status}`,
    title: `Synthetic ${status} item`,
    imageUrl: null,
    lastSeenAt: '2026-11-10T09:00:00Z',
    missingAt: '2026-11-11T09:00:00Z',
    checkedAt: null,
    status,
    checkError: null as string | null,
    notifiedAt: null as string | null,
    notifyError: null as string | null,
  }
}

function view(accountId = 'account-1') {
  return {
    accountId,
    homepageUrl: `https://www.vinted.com/member/${accountId}`,
    enabled: true,
    running: false,
    lastCompleteAt: null as string | null,
    lastItemCount: null as number | null,
    lastError: null as string | null,
    nextRunAt: '2026-11-11T10:00:00Z' as string | null,
    pendingCount: 1,
    soldCount: 0,
    candidates: [] as ReturnType<typeof candidate>[],
  }
}

let hooks: HookHarness
let props: Parameters<typeof OrderWatchPanel>[0]
let saved: ReturnType<typeof settings>
let summaries: ReturnType<typeof view>[]
let details: Record<string, ReturnType<typeof view>>
let handlers: Record<string, (payload: unknown) => unknown>

const tree = () => hooks.render(() => OrderWatchPanel(props))
const calls = (method: string) =>
  vi.mocked(callPlugin).mock.calls.filter((call) => call[2] === method)
const button = (label: string) =>
  components(tree(), Button).find(
    (node) => node.props['aria-label'] === label || text(node.props.children) === label,
  )!
const click = (label: string) => {
  const node = button(label)
  expect(node, `button ${label}`).toBeDefined()
  node.props.onClick?.({} as MouseEvent<HTMLButtonElement>)
}
const input = (label: string) =>
  components(tree(), Input).find((node) => node.props['aria-label'] === label)!
const edit = (label: string, value: string) =>
  input(label).props.onChange?.({ target: { value } } as ChangeEvent<HTMLInputElement>)
const submit = () => {
  const handler = elements(tree()).find((node) => node.type === 'form')!.props
    .onSubmit as (event: FormEvent<HTMLFormElement>) => void
  handler({ preventDefault() {} } as FormEvent<HTMLFormElement>)
}

async function settle() {
  for (let index = 0; index < 3; index += 1) {
    tree()
    hooks.flushEffects()
    await flushPromises()
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  hooks = new HookHarness(state)
  props = {
    open: true,
    onOpenChange: vi.fn(),
    plugin: plugin(),
    accounts: [
      { id: 'account-1', account: 'Seller One' },
      { id: 'account-2', account: 'Seller Two' },
    ],
  }
  saved = settings()
  summaries = [view(), view('account-2')]
  details = {
    'account-1': { ...view(), candidates: [candidate()] },
    'account-2': { ...view('account-2'), candidates: [candidate('sold')] },
  }
  handlers = {
    [METHODS.settings]: () => structuredClone(saved),
    [METHODS.save]: (payload) => {
      saved = structuredClone(payload as typeof saved)
      return saved
    },
    [METHODS.test]: () => ({ sent: true }),
    [METHODS.list]: (payload) => {
      const { accountId } = payload as { accountId?: string }
      return {
        items: structuredClone(
          accountId ? (details[accountId] ? [details[accountId]] : []) : summaries,
        ),
      }
    },
    [METHODS.run]: () => ({ queued: true }),
    [METHODS.enabled]: (payload) => ({
      enabled: (payload as { enabled: boolean }).enabled,
    }),
    'vinted.accounts.list': () => ({
      items: [],
      bindings: [],
      storageDurable: true,
      total: 0,
      page: 1,
      pageSize: 16,
      revision: 'a'.repeat(64),
    }),
  }
  vi.mocked(callPlugin).mockImplementation(async (_id, _capability, method, payload) => {
    const handler = handlers[method]
    if (!handler) throw new Error(`Unexpected RPC: ${method}`)
    return handler(payload) as never
  })
  vi.mocked(openExternalUrl).mockResolvedValue(undefined)
})

afterEach(() => {
  hooks.dispose()
  vi.useRealTimers()
})

describe('order watch panel', () => {
  it('polls summaries and only the selected detail while open, and stops on close', async () => {
    props.open = false
    await settle()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(callPlugin).not.toHaveBeenCalled()

    props.open = true
    await settle()
    expect(calls(METHODS.settings)).toHaveLength(1)
    expect(calls(METHODS.list).map((call) => call[3])).toEqual([
      {},
      { accountId: 'account-1' },
    ])
    expect(text(tree())).toContain('Seller One')
    expect(text(tree())).toContain('Synthetic pending item')
    expect(text(tree())).not.toContain('Synthetic sold item')

    await vi.advanceTimersByTimeAsync(5_000)
    await settle()
    expect(calls(METHODS.list).map((call) => call[3])).toEqual([
      {},
      { accountId: 'account-1' },
      {},
      { accountId: 'account-1' },
    ])
    props.open = false
    await settle()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls(METHODS.list)).toHaveLength(4)
    expect(tree()).toBeNull()
  })

  it('retains all configuration drafts on failed save and submits the full settings on retry', async () => {
    await settle()
    edit('扫描间隔（分钟）', '65')
    edit('Bark 服务地址', 'https://bark.example.test')
    edit('Bark 设备密钥', 'synthetic-draft-key')
    components(tree(), Switch)[0]!.props.onCheckedChange?.(true)
    handlers[METHODS.save] = () => {
      throw new Error('Config write failed')
    }
    submit()
    await settle()
    expect(input('扫描间隔（分钟）').props.value).toBe('65')
    expect(input('Bark 服务地址').props.value).toBe('https://bark.example.test')
    expect(input('Bark 设备密钥').props.value).toBe('synthetic-draft-key')
    expect(components(tree(), Switch)[0]!.props.checked).toBe(true)
    expect(text(tree())).toContain('Config write failed')
    expect(text(tree())).not.toContain('设置已保存')
    expect(button('测试已保存配置').props.disabled).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    await settle()
    expect(input('扫描间隔（分钟）').props.value).toBe('65')

    handlers[METHODS.save] = (payload) => payload
    submit()
    await settle()
    expect(calls(METHODS.save).map((call) => call.slice(0, 4))).toEqual([
      [
        'studio.vinted-accounts',
        'account.pool',
        METHODS.save,
        {
          intervalMinutes: 65,
          bark: {
            baseUrl: 'https://bark.example.test',
            deviceKey: 'synthetic-draft-key',
            enabled: true,
          },
        },
      ],
      [
        'studio.vinted-accounts',
        'account.pool',
        METHODS.save,
        {
          intervalMinutes: 65,
          bark: {
            baseUrl: 'https://bark.example.test',
            deviceKey: 'synthetic-draft-key',
            enabled: true,
          },
        },
      ],
    ])
    expect(text(tree())).toContain('设置已保存')
    expect(button('测试已保存配置').props.disabled).toBe(false)
  })

  it.each(['', '4', '1441', '30.5'])(
    'rejects invalid interval %j before any write',
    async (value) => {
      await settle()
      edit('扫描间隔（分钟）', value)
      submit()
      await settle()
      expect(calls(METHODS.save)).toHaveLength(0)
      expect(input('扫描间隔（分钟）').props['aria-invalid']).toBe(true)
      expect(text(tree())).toContain('5–1440')
    },
  )

  it('masks the key and tests only the saved configuration, never an unsaved key', async () => {
    await settle()
    expect(input('Bark 设备密钥').props.type).toBe('password')
    expect(button('测试已保存配置').props.disabled).toBe(true)
    edit('Bark 设备密钥', 'synthetic-saved-key')
    expect(button('测试已保存配置').props.disabled).toBe(true)
    click('测试已保存配置')
    await settle()
    expect(calls(METHODS.test)).toHaveLength(0)

    submit()
    await settle()
    edit('Bark 设备密钥', 'synthetic-unsaved-key')
    edit('Bark 服务地址', 'https://unsaved.example.test')
    click('测试已保存配置')
    await settle()
    expect(calls(METHODS.test).map((call) => call[3])).toEqual([{}])
    expect(calls(METHODS.save)).toHaveLength(1)
    expect(saved.bark.deviceKey).toBe('synthetic-saved-key')
    expect(input('Bark 设备密钥').props.value).toBe('synthetic-unsaved-key')
    expect(input('Bark 设备密钥').props.type).toBe('password')
    expect(text(tree())).toContain('测试通知已发送')
  })

  it('queues a manual query once without reporting a completed scan', async () => {
    await settle()
    const pending = deferred<{ queued: boolean }>()
    handlers[METHODS.run] = () => pending.promise
    click('立即查询 Seller One')
    click('立即查询 Seller One')
    expect(calls(METHODS.run).map((call) => call[3])).toEqual([
      { accountId: 'account-1' },
    ])
    expect(button('立即查询 Seller One').props.disabled).toBe(true)
    expect(text(tree())).not.toContain('已加入查询队列')
    pending.resolve({ queued: true })
    await settle()
    expect(text(tree())).toContain('已加入查询队列')
    expect(text(tree())).toContain('尚未完整扫描')

    handlers[METHODS.run] = () => ({ queued: false })
    click('立即查询 Seller One')
    await settle()
    expect(text(tree())).toContain('当前查询繁忙')
    expect(text(tree())).not.toContain('已加入查询队列')
  })

  it('updates pause only after the backend accepts it and retains failures for retry', async () => {
    await settle()
    const pending = deferred<{ enabled: boolean }>()
    handlers[METHODS.enabled] = () => pending.promise
    click('暂停 Seller One')
    click('暂停 Seller One')
    expect(calls(METHODS.enabled).map((call) => call[3])).toEqual([
      { accountId: 'account-1', enabled: false },
    ])
    expect(button('暂停 Seller One').props.disabled).toBe(true)
    pending.reject(new Error('Pause failed'))
    await settle()
    expect(text(tree())).toContain('Pause failed')
    expect(button('暂停 Seller One').props.disabled).toBe(false)
    handlers[METHODS.enabled] = () => ({ enabled: false })
    click('暂停 Seller One')
    await settle()
    expect(button('启用 Seller One').props.disabled).toBe(false)
    expect(button('立即查询 Seller One').props.disabled).toBe(true)
  })

  it('switches detail requests and ignores late candidates for the previous account', async () => {
    const pending = deferred<{ items: ReturnType<typeof view>[] }>()
    const list = handlers[METHODS.list]!
    handlers[METHODS.list] = (payload) =>
      (payload as { accountId?: string }).accountId === 'account-1'
        ? pending.promise
        : list(payload)
    await settle()
    click('查看 Seller Two 的核查记录')
    await settle()
    expect(calls(METHODS.list).map((call) => call[3])).toEqual([
      {},
      { accountId: 'account-1' },
      { accountId: 'account-2' },
    ])
    expect(text(tree())).toContain('Synthetic sold item')
    pending.resolve({
      items: [{ ...view(), candidates: [{ ...candidate(), title: 'Late old item' }] }],
    })
    await settle()
    expect(text(tree())).not.toContain('Late old item')
  })

  it('does not overlap polls and recovers from a status read failure', async () => {
    const pending = deferred<{ items: ReturnType<typeof view>[] }>()
    handlers[METHODS.list] = () => pending.promise
    await settle()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls(METHODS.list)).toHaveLength(1)
    pending.reject(new Error('Status unavailable'))
    await settle()
    expect(text(tree())).toContain('Status unavailable')
    handlers[METHODS.list] = () => ({ items: summaries })
    await vi.advanceTimersByTimeAsync(5_000)
    await settle()
    expect(text(tree())).not.toContain('Status unavailable')
    expect(text(tree())).toContain('Seller One')
  })

  it('ignores old settings, polls, and saves after closing or changing process identity', async () => {
    await settle()
    const pending = deferred<ReturnType<typeof settings>>()
    handlers[METHODS.save] = () => pending.promise
    edit('扫描间隔（分钟）', '65')
    submit()
    props.open = false
    await settle()
    props.open = true
    props.plugin = plugin({ status: { pid: 101 } })
    saved = { ...settings(), intervalMinutes: 15 }
    await settle()
    expect(input('扫描间隔（分钟）').props.value).toBe('15')
    pending.resolve({ ...settings('synthetic-old-key'), intervalMinutes: 65 })
    await settle()
    expect(input('扫描间隔（分钟）').props.value).toBe('15')
    expect(input('Bark 设备密钥').props.value).toBe('')
    expect(text(tree())).not.toContain('设置已保存')
  })

  it('ignores late list results after close and leaves no timers on unmount', async () => {
    const pending = deferred<{ items: ReturnType<typeof view>[] }>()
    handlers[METHODS.list] = () => pending.promise
    await settle()
    props.open = false
    await settle()
    pending.resolve({ items: [view('old-account')] })
    await flushPromises()
    expect(tree()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    hooks.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders invalid homepages and summary counts without treating disappearance as a sale', async () => {
    summaries[1] = {
      ...view('account-2'),
      homepageUrl: 'invalid-homepage',
      enabled: false,
      nextRunAt: null,
      lastError: '主页链接不是有效的 Vinted 用户主页',
      pendingCount: 0,
      soldCount: 0,
    }
    await settle()
    expect(text(tree())).toContain('主页链接不是有效的 Vinted 用户主页')
    expect(text(tree())).toContain('首次完整扫描只建立基线')
    expect(text(tree())).toContain('商品消失后需由商品页确认已售')
    expect(text(tree())).toContain('不是已登录账号的真实订单')
    expect(text(tree())).toContain('待核查 1')
    expect(text(tree())).toContain('页面确认已售 0')
    expect(button('立即查询 Seller Two').props.disabled).toBe(true)
  })

  it('uses the selected detail error and homepage instead of the compact summary values', async () => {
    summaries[0]!.lastError = '查询失败，请查看详情'
    details['account-1']!.lastError = '主页查询失败：上游返回 429，请稍后重试'
    summaries[1] = {
      ...view('account-2'),
      homepageUrl: '',
      enabled: false,
      lastError: '主页链接无效',
    }
    details['account-2'] = {
      ...summaries[1],
      homepageUrl: 'original-invalid-homepage',
    }
    await settle()
    expect(text(tree())).toContain('主页查询失败：上游返回 429，请稍后重试')
    expect(text(tree())).not.toContain('查询失败，请查看详情')
    click('查看 Seller Two 的核查记录')
    await settle()
    expect(text(tree())).toContain('original-invalid-homepage')
    expect(button('打开 Seller Two 的主页').props.disabled).toBe(true)
  })

  it('shows check and push failures and opens item and homepage links through the platform', async () => {
    details['account-1']!.candidates = [
      { ...candidate(), checkError: 'Page not accessible' },
      { ...candidate('sold'), notifyError: 'Bark unavailable' },
      candidate('reappeared'),
    ]
    await settle()
    expect(text(tree())).toContain('Page not accessible')
    expect(text(tree())).toContain('Bark unavailable')
    expect(text(tree())).toContain('重新出现')
    click('打开 Seller One 的主页')
    click('打开商品 Synthetic pending item')
    await settle()
    expect(vi.mocked(openExternalUrl).mock.calls).toEqual([
      ['https://www.vinted.com/member/account-1'],
      ['https://www.vinted.com/items/pending'],
    ])
    vi.mocked(openExternalUrl).mockRejectedValue(new Error('Open failed'))
    click('打开商品 Synthetic pending item')
    await settle()
    expect(text(tree())).toContain('Open failed')
  })

  it('loads settings again after a read failure without allowing a default overwrite', async () => {
    handlers[METHODS.settings] = () => {
      throw new Error('Settings unavailable')
    }
    await settle()
    expect(text(tree())).toContain('Settings unavailable')
    expect(components(tree(), Input)).toHaveLength(0)
    expect(calls(METHODS.save)).toHaveLength(0)
    handlers[METHODS.settings] = () => settings('synthetic-recovered-key')
    click('重试读取设置')
    await settle()
    expect(input('Bark 设备密钥').props.value).toBe('synthetic-recovered-key')
    expect(components(tree(), Dialog)[0]!.props.open).toBe(true)
  })

  it('rejects malformed settings and status results instead of presenting defaults', async () => {
    handlers[METHODS.settings] = () => ({
      intervalMinutes: 1,
      bark: { baseUrl: 'https://api.day.app', deviceKey: '', enabled: false },
    })
    handlers[METHODS.list] = () => ({ items: [{ ...view(), running: 'ready' }] })
    await settle()
    expect(text(tree())).toContain('数据格式无效')
    expect(components(tree(), Input)).toHaveLength(0)
    expect(text(tree())).not.toContain('Seller One')
    expect(calls(METHODS.save)).toHaveLength(0)
  })

  it('reports Bark failures without losing drafts and rejects a malformed test receipt', async () => {
    saved = settings('synthetic-saved-key')
    await settle()
    edit('扫描间隔（分钟）', '45')
    handlers[METHODS.test] = () => {
      throw new Error('Bark failed')
    }
    click('测试已保存配置')
    await settle()
    expect(text(tree())).toContain('Bark failed')
    expect(input('扫描间隔（分钟）').props.value).toBe('45')
    handlers[METHODS.test] = () => ({ sent: false })
    click('测试已保存配置')
    await settle()
    expect(text(tree())).toContain('数据格式无效')
    expect(text(tree())).not.toContain('测试通知已发送')
  })
})
