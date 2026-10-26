import {
  Children,
  createElement,
  isValidElement,
  type ChangeEvent,
  type ComponentProps,
  type DependencyList,
  type EffectCallback,
  type FormEvent,
  type JSXElementConstructor,
  type ReactElement,
  type ReactNode,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlertDialogAction } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogContent } from '@/components/ui/dialog'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectGroup, SelectItem, SelectTrigger } from '@/components/ui/select'
import { TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toast'
import { AccountEditor } from '@/features/accounts/account-editor'
import {
  ACCOUNT_STATUSES,
  type Account,
  type AccountInput,
  type AccountList,
  type BindingView,
} from '@/features/accounts/types'
import type { WindowGroup } from '@/lib/platform/native-groups'
import {
  createNativeProfile,
  listNativeProfiles,
  operateNativeProfile,
  updateNativeProfile,
  type NativeProfile,
} from '@/lib/platform/native-profiles'
import type { PluginView } from '@/lib/platform/native-plugins'
import { AccountPhoneCopy, AccountSmsPopover } from './account-sms-popover'
import { ProxyGateDialog } from './proxy-gate'
import { SpacesPage } from './spaces-page'
import { WindowEditor } from './window-editor'
import { checkWindowProxy, type ProxyCheckOutcome } from './window-proxy'

const state = vi.hoisted(() => ({
  hooks: null as HookHarness | null,
  native: false,
  plugin: null as PluginView | null,
  pluginError: null as Error | null,
  accounts: [] as Account[],
  bindings: [] as BindingView[],
  windows: [] as NativeProfile[],
  groups: [] as WindowGroup[],
  calls: [] as { method: string; input: unknown }[],
  saved: null as Account | null,
  listError: null as Error | null,
  bindingsError: null as Error | null,
  listResponse: null as Promise<AccountList> | null,
  saveError: null as Error | null,
  saveResponse: null as Promise<{ item: Account; created: boolean }> | null,
  bindResponse: { bound: true, duplicates: [] as string[] },
  realLaunch: false,
  profileReadResponse: null as Promise<NativeProfile[]> | null,
}))

// Run the actual component handlers in the Node test environment. Child components
// stay as React elements; DOM behavior and Radix focus management are not simulated.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  const {
    useState: realState,
    useRef: realRef,
    useEffect: realEffect,
    useCallback: realCallback,
    useId: realId,
  } = react
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : realState(initial),
    useRef: (initial: unknown) =>
      state.hooks ? state.hooks.state(() => ({ current: initial }))[0] : realRef(initial),
    useId: () => (state.hooks ? state.hooks.state('test-contact-id')[0] : realId()),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : realEffect(effect, deps),
    useCallback: <T extends (...args: never[]) => unknown>(
      callback: T,
      deps: DependencyList,
    ) => (state.hooks ? state.hooks.memo(callback, deps) : realCallback(callback, deps)),
  }
})

vi.mock('@/lib/platform/native-plugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-plugins')>()),
  listPlugins: async () => {
    if (state.pluginError) throw state.pluginError
    return state.plugin ? [state.plugin] : []
  },
  pluginHostAvailable: () => state.native,
  callPlugin: async (
    _plugin: string,
    _capability: string,
    method: string,
    input: unknown,
  ) => {
    state.calls.push({ method, input })
    if (method === 'vinted.accounts.list') {
      if (state.listError) throw state.listError
      return (
        state.listResponse ?? {
          items: state.accounts,
          bindings: state.bindings,
          total: state.accounts.length,
          storageDurable: true,
        }
      )
    }
    if (method === 'vinted.accounts.bindings') {
      if (state.bindingsError) throw state.bindingsError
      return { items: state.bindings }
    }
    if (method === 'vinted.accounts.save') {
      if (state.saveError) throw state.saveError
      return state.saveResponse ?? { item: state.saved, created: false }
    }
    if (method === 'vinted.accounts.bind') return state.bindResponse
    if (method === 'vinted.accounts.unbind') return { unbound: true }
    throw new Error(`Unexpected account method: ${method}`)
  },
}))

vi.mock('@/lib/platform/native-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-profiles')>()),
  nativeProfilesAvailable: () => state.native,
  listNativeProfiles: vi.fn(async () => state.profileReadResponse ?? state.windows),
  operateNativeProfile: vi.fn(async () => undefined),
  createNativeProfile: vi.fn(async () => ({
    ...state.windows[0]!,
    id: 'created',
    name: 'created',
  })),
  updateNativeProfile: vi.fn(async () => undefined),
}))
vi.mock('@/lib/platform/native-groups', () => ({ listGroups: async () => state.groups }))
vi.mock('@/lib/platform/native-license', () => ({
  getLicenseStatus: async () => ({ configured: true }),
}))
vi.mock('./use-transfer-recovery', () => ({
  useTransferRecovery: () => ({
    status: null,
    error: null,
    checking: false,
    retry: () => undefined,
  }),
}))
vi.mock('./use-window-launch', async (importOriginal) => {
  const { useWindowLaunch: realController } =
    await importOriginal<typeof import('./use-window-launch')>()
  return {
    useWindowLaunch: (...args: Parameters<typeof realController>) =>
      state.realLaunch
        ? realController(...args)
        : {
            gate: null,
            operatingWindows: new Set(),
            startingWindows: new Set(),
            unconfirmedWindows: new Set(),
          },
  }
})
vi.mock('./window-proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./window-proxy')>()),
  checkWindowProxy: vi.fn(),
}))
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

class HookHarness {
  private values: unknown[] = []
  private cursor = 0
  private effectCursor = 0
  private effects: {
    deps: DependencyList | undefined
    callback: EffectCallback
    cleanup?: () => void
  }[] = []
  private queued: number[] = []

  state(initial: unknown): [unknown, (next: unknown) => void] {
    const index = this.cursor++
    if (index === this.values.length) {
      this.values.push(typeof initial === 'function' ? initial() : initial)
    }
    return [
      this.values[index],
      (next) => {
        this.values[index] = typeof next === 'function' ? next(this.values[index]) : next
      },
    ]
  }

  memo<T>(value: T, deps: DependencyList): T {
    const index = this.cursor++
    const previous = this.values[index] as { value: T; deps: DependencyList } | undefined
    if (
      !previous ||
      previous.deps.length !== deps.length ||
      deps.some((dep, i) => !Object.is(dep, previous.deps[i]))
    ) {
      this.values[index] = { value, deps }
      return value
    }
    return previous.value
  }

  effect(callback: EffectCallback, deps?: DependencyList) {
    const index = this.effectCursor++
    const previous = this.effects[index]
    if (
      previous?.deps &&
      deps &&
      previous.deps.length === deps.length &&
      deps.every((value, i) => Object.is(value, previous.deps?.[i]))
    ) {
      return
    }
    previous?.cleanup?.()
    this.effects[index] = { callback, deps }
    this.queued.push(index)
  }

  render(component: () => ReactElement): ReactElement {
    this.cursor = 0
    this.effectCursor = 0
    state.hooks = this
    try {
      return component()
    } finally {
      state.hooks = null
    }
  }

  flushEffects() {
    for (const index of this.queued.splice(0)) {
      const cleanup = this.effects[index]!.callback()
      if (typeof cleanup === 'function') this.effects[index]!.cleanup = cleanup
    }
  }

  dispose() {
    for (const effect of this.effects) effect.cleanup?.()
  }
}

const harnesses: HookHarness[] = []
function harness() {
  const instance = new HookHarness()
  harnesses.push(instance)
  return instance
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...elements(child.props.children as ReactNode)]
      : [],
  )
}

function components<P>(tree: ReactNode, type: JSXElementConstructor<P>) {
  return elements(tree).filter((node) => node.type === type) as ReactElement<P>[]
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'shared',
    account: 'shared@example.com',
    loginMethod: 'email',
    password: '  example password  ',
    status: 'active',
    phone: '+14155550100',
    emailOtpUrl: 'https://mail.example.com/original',
    smsOtpUrl: 'https://sms.example.com/original',
    homepageUrl: 'https://www.vinted.fr/member/123',
    note: 'original note',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  }
}

function profile(id: string, running = false): NativeProfile {
  return {
    id,
    name: id,
    running,
    version: '155.0.1.2',
    groupId: null,
    proxy: null,
    proxyPlugin: null,
    proxyEndpoint: null,
    createdAt: 0,
    lastOpenedAt: null,
    settings: {
      platform: 'Vinted',
      note: '',
      geoip: true,
      timezone: '',
      locale: '',
      viewport: 'default',
      fingerprintSeed: 42,
      startUrl: '',
    },
  }
}

function bind(windowId: string, item: Account): BindingView {
  return {
    windowId,
    accountId: item.id,
    boundAt: '2026-10-03T00:00:00.000Z',
    account: {
      id: item.id,
      account: item.account,
      loginMethod: item.loginMethod,
      status: item.status,
      note: item.note,
    },
  }
}

function checkedProxy(): ProxyCheckOutcome {
  return {
    kind: 'checked',
    result: {
      id: 'proxy',
      ok: true,
      scheme: 'http',
      exitIp: '203.0.113.10',
      geo: null,
      reputation: null,
      latencyMs: 1,
      error: null,
      checkedAt: '2026-10-26T00:00:00.000Z',
      saved: false,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.native = false
  state.plugin = {
    id: 'studio.vinted-accounts',
    state: 'running',
    enabled: true,
  } as PluginView
  state.accounts = [account(), account({ id: 'other', account: 'other@example.com' })]
  state.windows = [profile('first'), profile('second', true), profile('third')]
  state.bindings = [
    bind('first', state.accounts[0]!),
    bind('second', state.accounts[0]!),
    bind('third', state.accounts[1]!),
  ]
  state.saved = account({ status: 'blocked' })
  state.groups = []
  state.pluginError = null
  state.listError = null
  state.bindingsError = null
  state.listResponse = null
  state.saveError = null
  state.saveResponse = null
  state.bindResponse = { bound: true, duplicates: [] }
  state.realLaunch = false
  state.profileReadResponse = null
  vi.mocked(operateNativeProfile).mockReset().mockResolvedValue(undefined)
  vi.mocked(checkWindowProxy).mockReset().mockResolvedValue(checkedProxy())
  state.calls = []
})

afterEach(() => {
  for (const instance of harnesses.splice(0)) instance.dispose()
  vi.useRealTimers()
})

async function mountedPage(waitForAccounts = true) {
  state.native = true
  const page = harness()
  const render = () => {
    const tree = page.render(SpacesPage)
    page.flushEffects()
    return tree
  }
  await vi.waitFor(() => {
    const tree = render()
    expect(visibleWindowNames(tree)).toHaveLength(state.windows.length)
    if (
      waitForAccounts &&
      state.plugin?.state === 'running' &&
      !state.pluginError &&
      !state.listError &&
      !state.bindingsError
    ) {
      expect(filterControl(tree, '筛选账号状态').props.disabled).toBe(false)
    }
  })
  return { render }
}

function visibleWindowNames(tree: ReactNode) {
  return components(tree, Button).flatMap((node) => {
    const match = node.props['aria-label']?.match(/^查看 (.*) 详情$/)
    return match ? [match[1]!] : []
  })
}

function windowRow(tree: ReactNode, name: string) {
  const row = components(tree, TableRow).find((node) =>
    components(node, Button).some(
      (button) => button.props['aria-label'] === `查看 ${name} 详情`,
    ),
  )
  expect(row, `Missing window row ${name}`).toBeDefined()
  return row!
}

function windowAction(tree: ReactNode, name: string, text: string) {
  const action = components(windowRow(tree, name), Button).find((node) =>
    Children.toArray(node.props.children).includes(text),
  )
  expect(action, `Missing window action ${name}: ${text}`).toBeDefined()
  return action!
}

function windowStatus(tree: ReactNode, name: string) {
  const status = elements(windowRow(tree, name)).find(
    (node) =>
      typeof node.props.className === 'string' &&
      node.props.className.split(' ').includes('status-badge'),
  )!
  return Children.toArray(status.props.children as ReactNode)
    .filter((child) => typeof child === 'string')
    .join('')
}

function filterControl(tree: ReactNode, label: string) {
  const control = components(tree, Select).find((node) =>
    components(node, SelectTrigger).some(
      (trigger) => trigger.props['aria-label'] === label,
    ),
  )
  expect(control, `Missing filter ${label}`).toBeDefined()
  return control!
}

function editFromCell(tree: ReactNode) {
  const trigger = components(tree, Button).find(
    (node) => node.props['aria-label'] === '编辑 shared@example.com 的账号资料',
  )
  expect(trigger?.props.disabled).toBe(false)
  trigger?.props.onClick?.({} as never)
}

function unlinkButtons(tree: ReactNode, login = 'shared@example.com') {
  return components(tree, Button).filter(
    (node) => node.props['aria-label'] === `解绑 ${login} 的手机号`,
  )
}

function localComponents(tree: ReactNode, name: string) {
  return elements(tree).filter(
    (node) => typeof node.type === 'function' && node.type.name === name,
  )
}

function refreshButton(tree: ReactNode) {
  return components(tree, Button).find((node) =>
    Children.toArray(node.props.children).some(
      (text) => text === '刷新' || text === '刷新中…',
    ),
  )!
}

function accountSnapshot(items = state.accounts): AccountList {
  return {
    items,
    bindings: state.bindings,
    total: items.length,
    storageDurable: true,
  }
}

function accountReadCount() {
  return state.calls.filter((call) => call.method === 'vinted.accounts.list').length
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function editorSession(props: ComponentProps<typeof AccountEditor>) {
  const editor = harness()
  const render = (overrides: Partial<typeof props> = {}) =>
    editor.render(() => AccountEditor({ ...props, ...overrides }))
  return {
    render,
    change(id: string, value: string) {
      const field = components(render(), Input).find((node) => node.props.id === id)
      expect(field, `Missing editor field ${id}`).toBeDefined()
      field?.props.onChange?.({ target: { value } } as ChangeEvent<HTMLInputElement>)
    },
    select(value: string, initial: string) {
      const field = components(render(), Select).find(
        (node) => node.props.value === initial,
      )
      expect(field, `Missing editor selection ${initial}`).toBeDefined()
      field?.props.onValueChange?.(value)
    },
    submit(tree = render()) {
      const form = elements(tree).find((node) => node.type === 'form')
      const submit = form?.props.onSubmit as (event: FormEvent) => void
      submit({ preventDefault: () => undefined } as FormEvent)
    },
  }
}

describe('window management', () => {
  it('does not offer a local-only window creation flow in a web preview', () => {
    const html = renderToStaticMarkup(createElement(SpacesPage))
    expect(html).not.toContain('浏览器 Profiles')
    expect(html).not.toContain('配置保存在本地')
    expect(html).toContain('请在 Nexus 桌面应用中创建和打开窗口')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?创建窗口<\/button>/s)
    const buttons =
      html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g) ?? []
    expect(buttons.find((button) => button.endsWith('批量创建</button>'))).toMatch(
      /\bdisabled=""/,
    )
  })

  it('keeps migration controls disabled and renders no fabricated windows in a preview', () => {
    const html = renderToStaticMarkup(createElement(SpacesPage))
    const buttons =
      html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g) ?? []
    for (const label of ['导出', '导入', '设备同步']) {
      expect(buttons.find((button) => button.endsWith(`${label}</button>`))).toMatch(
        /\bdisabled=""/,
      )
    }
    expect(html).toContain('全选当前筛选下的已关闭窗口')
    expect(html).toContain('已选 0')
    expect(html).toContain('还没有窗口')
  })

  it('forwards the selected kernel only when creating a new window', async () => {
    const page = await mountedPage()
    const create = components(page.render(), Button).find((node) =>
      Children.toArray(node.props.children).includes('创建窗口'),
    )
    expect(create).toBeDefined()
    create?.props.onClick?.({} as never)
    const settings = profile('new').settings
    await components(page.render(), WindowEditor)[0]!.props.onSave(
      'new',
      null,
      null,
      null,
      settings,
      'group-1',
      '155.0.1.2.7',
    )
    expect(createNativeProfile).toHaveBeenCalledExactlyOnceWith(
      'new',
      null,
      null,
      null,
      settings,
      'group-1',
      '155.0.1.2.7',
    )
    expect(updateNativeProfile).not.toHaveBeenCalled()

    const edit = components(page.render(), Button).find(
      (node) => node.props['aria-label'] === '编辑 first',
    )
    expect(edit).toBeDefined()
    edit?.props.onClick?.({} as never)
    await components(page.render(), WindowEditor)[0]!.props.onSave(
      'renamed',
      null,
      null,
      null,
      settings,
      'group-2',
      '155.0.1.2.8',
    )
    expect(updateNativeProfile).toHaveBeenCalledExactlyOnceWith(
      'first',
      'renamed',
      null,
      null,
      null,
      settings,
      'group-2',
    )
    expect(createNativeProfile).toHaveBeenCalledOnce()
  })
})

describe('starting window row highlighting', () => {
  it('highlights a pending launch, never a simultaneous stop, and clears after confirmed startup', async () => {
    state.realLaunch = true
    const page = await mountedPage()
    const start = deferred<void>()
    const stop = deferred<void>()
    vi.mocked(operateNativeProfile).mockImplementation((id, running) => {
      if (id === 'first' && !running) return start.promise
      if (id === 'second' && running) return stop.promise
      throw new Error('Unexpected native operation')
    })
    windowAction(page.render(), 'first', '打开').props.onClick?.({} as never)
    windowAction(page.render(), 'second', '停止').props.onClick?.({} as never)
    const pending = page.render()
    expect(windowRow(pending, 'first').props.className).toBe('space-row-starting')
    expect(windowRow(pending, 'first').props['aria-busy']).toBe(true)
    expect(windowStatus(pending, 'first')).toBe('启动中')
    expect(windowAction(pending, 'first', '正在打开…').props.disabled).toBe(true)
    expect(windowAction(pending, 'second', '正在停止…').props.disabled).toBe(true)
    expect(windowRow(pending, 'second').props.className).toBeUndefined()
    expect(windowRow(pending, 'third').props.className).toBeUndefined()

    state.windows = state.windows.map((window) =>
      window.id === 'first' ? { ...window, running: true } : window,
    )
    start.resolve()
    await vi.waitFor(() => expect(windowStatus(page.render(), 'first')).toBe('运行中'))
    expect(windowRow(page.render(), 'first').props.className).toBeUndefined()
    expect(windowRow(page.render(), 'first').props['aria-busy']).toBeUndefined()
    state.windows = state.windows.map((window) =>
      window.id === 'second' ? { ...window, running: false } : window,
    )
    stop.resolve()
    await vi.waitFor(() => expect(windowStatus(page.render(), 'second')).toBe('已停止'))
    expect(windowRow(page.render(), 'second').props.className).toBeUndefined()
    expect(operateNativeProfile).toHaveBeenNthCalledWith(1, 'first', false)
    expect(operateNativeProfile).toHaveBeenNthCalledWith(2, 'second', true)
  })

  it('clears the highlight after a definite launch rejection', async () => {
    state.realLaunch = true
    const page = await mountedPage()
    const start = deferred<void>()
    vi.mocked(operateNativeProfile).mockReturnValue(start.promise)
    windowAction(page.render(), 'first', '打开').props.onClick?.({} as never)
    expect(windowRow(page.render(), 'first').props.className).toBe('space-row-starting')
    start.reject(new Error('启动已被宿主阻止'))
    await vi.waitFor(() => {
      expect(components(page.render(), FieldError)[0]?.props.children).toBe(
        '启动已被宿主阻止',
      )
      expect(windowStatus(page.render(), 'first')).toBe('已停止')
    })
    expect(windowRow(page.render(), 'first').props.className).toBeUndefined()
  })

  it('highlights a pending proxy check and clears it when the gate blocks startup', async () => {
    state.realLaunch = true
    state.windows[0] = { ...state.windows[0]!, proxy: 'http://proxy.example.com:8080' }
    const page = await mountedPage()
    const check = deferred<ProxyCheckOutcome>()
    vi.mocked(checkWindowProxy).mockReturnValue(check.promise)
    windowAction(page.render(), 'first', '打开').props.onClick?.({} as never)
    expect(windowRow(page.render(), 'first').props.className).toBe('space-row-starting')
    expect(windowStatus(page.render(), 'first')).toBe('检测代理中')
    expect(operateNativeProfile).not.toHaveBeenCalled()
    check.resolve({ kind: 'unsupported', reason: '代理池暂不可用' })
    await vi.waitFor(() => {
      expect(components(page.render(), ProxyGateDialog)[0]!.props.stage.stage).toBe(
        'blocked',
      )
    })
    expect(windowRow(page.render(), 'first').props.className).toBeUndefined()
    expect(windowStatus(page.render(), 'first')).toBe('已停止')
    expect(operateNativeProfile).not.toHaveBeenCalled()
    components(page.render(), ProxyGateDialog)[0]!.props.onCancel()
    expect(components(page.render(), ProxyGateDialog)).toHaveLength(0)
  })

  it('keeps the proxy row highlighted through checking and launching until the host confirms running', async () => {
    state.realLaunch = true
    state.windows[0] = { ...state.windows[0]!, proxy: 'http://proxy.example.com:8080' }
    const page = await mountedPage()
    const check = deferred<ProxyCheckOutcome>()
    const start = deferred<void>()
    vi.mocked(checkWindowProxy).mockReturnValue(check.promise)
    vi.mocked(operateNativeProfile).mockReturnValue(start.promise)
    windowAction(page.render(), 'first', '打开').props.onClick?.({} as never)
    expect(windowStatus(page.render(), 'first')).toBe('检测代理中')
    check.resolve(checkedProxy())
    await vi.waitFor(() => expect(windowStatus(page.render(), 'first')).toBe('启动中'))
    expect(windowRow(page.render(), 'first').props.className).toBe('space-row-starting')
    expect(components(page.render(), ProxyGateDialog)[0]!.props.stage.stage).toBe(
      'launching',
    )
    state.windows = state.windows.map((window) =>
      window.id === 'first' ? { ...window, running: true } : window,
    )
    start.resolve()
    await vi.waitFor(() => {
      expect(windowStatus(page.render(), 'first')).toBe('运行中')
      expect(components(page.render(), ProxyGateDialog)).toHaveLength(0)
    })
    expect(windowRow(page.render(), 'first').props.className).toBeUndefined()
  })

  it('keeps an unconfirmed late start highlighted after closing its gate until a status read confirms running', async () => {
    vi.useFakeTimers()
    state.realLaunch = true
    state.windows[0] = { ...state.windows[0]!, proxy: 'http://proxy.example.com:8080' }
    const page = await mountedPage()
    const start = deferred<void>()
    vi.mocked(operateNativeProfile).mockReturnValue(start.promise)
    windowAction(page.render(), 'first', '打开').props.onClick?.({} as never)
    await vi.waitFor(() => expect(windowStatus(page.render(), 'first')).toBe('启动中'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(windowStatus(page.render(), 'first')).toBe('状态待确认')
    expect(windowRow(page.render(), 'first').props.className).toBe('space-row-starting')
    components(page.render(), ProxyGateDialog)[0]!.props.onCancel()
    expect(components(page.render(), ProxyGateDialog)).toHaveLength(0)
    expect(windowRow(page.render(), 'first').props.className).toBe('space-row-starting')
    windowAction(page.render(), 'first', '确认状态').props.onClick?.({} as never)
    await vi.waitFor(() => {
      const stage = components(page.render(), ProxyGateDialog)[0]!.props.stage
      expect(stage.stage === 'unconfirmed' && !stage.reading).toBe(true)
    })
    expect(windowRow(page.render(), 'first').props.className).toBe('space-row-starting')
    expect(operateNativeProfile).toHaveBeenCalledTimes(1)

    const confirmation = deferred<NativeProfile[]>()
    state.profileReadResponse = confirmation.promise
    const reads = vi.mocked(listNativeProfiles).mock.calls.length
    start.resolve()
    await vi.waitFor(() => expect(listNativeProfiles).toHaveBeenCalledTimes(reads + 1))
    expect(windowRow(page.render(), 'first').props.className).toBe('space-row-starting')
    confirmation.resolve(
      state.windows.map((window) =>
        window.id === 'first' ? { ...window, running: true } : window,
      ),
    )
    await vi.waitFor(() => expect(windowStatus(page.render(), 'first')).toBe('运行中'))
    expect(windowRow(page.render(), 'first').props.className).toBeUndefined()
    expect(components(page.render(), ProxyGateDialog)).toHaveLength(0)
  })

  it('keeps failed startup confirmation highlighted until a subsequent read confirms the settled window is stopped', async () => {
    state.realLaunch = true
    const page = await mountedPage()
    const confirmation = deferred<NativeProfile[]>()
    state.profileReadResponse = confirmation.promise
    const reads = vi.mocked(listNativeProfiles).mock.calls.length
    windowAction(page.render(), 'first', '打开').props.onClick?.({} as never)
    await vi.waitFor(() => expect(listNativeProfiles).toHaveBeenCalledTimes(reads + 1))
    confirmation.reject(new Error('状态接口暂不可用'))
    await vi.waitFor(() =>
      expect(windowStatus(page.render(), 'first')).toBe('状态待确认'),
    )
    expect(windowRow(page.render(), 'first').props.className).toBe('space-row-starting')
    state.profileReadResponse = null
    windowAction(page.render(), 'first', '确认状态').props.onClick?.({} as never)
    await vi.waitFor(() => expect(windowStatus(page.render(), 'first')).toBe('已停止'))
    expect(windowRow(page.render(), 'first').props.className).toBeUndefined()
    expect(components(page.render(), ProxyGateDialog)[0]!.props.stage.stage).toBe(
      'failed',
    )
    expect(operateNativeProfile).toHaveBeenCalledTimes(1)
  })
})

describe('window account status filtering', () => {
  it('offers grouped status options and combines account, group and search filters in newest order', async () => {
    state.accounts[0] = account({ status: 'blocked' })
    state.groups = [{ id: 'work', name: '工作组', note: '', windowCount: 4 }]
    state.windows = [
      { ...profile('first'), createdAt: 100, groupId: 'work' },
      { ...profile('second', true), createdAt: 300, groupId: 'work' },
      { ...profile('third'), createdAt: 500, groupId: 'other' },
      { ...profile('fourth'), createdAt: 600, groupId: 'work' },
      { ...profile('fifth'), createdAt: 400, groupId: 'work' },
      { ...profile('sixth'), createdAt: 700 },
    ].map((window) => ({
      ...window,
      settings: {
        ...window.settings,
        note: window.id === 'fourth' ? 'different' : 'Target window',
      },
    }))
    state.bindings = state.windows.map((window) =>
      bind(
        window.id,
        state.accounts[window.id === 'third' || window.id === 'fifth' ? 1 : 0]!,
      ),
    )
    const page = await mountedPage()
    const status = filterControl(page.render(), '筛选账号状态')
    const group = filterControl(page.render(), '筛选分组')
    expect(components(status, SelectGroup)).toHaveLength(1)
    expect(components(group, SelectGroup)).toHaveLength(1)
    expect(
      components(components(status, SelectGroup)[0], SelectItem).map(
        (node) => node.props.value,
      ),
    ).toEqual(['all', ...ACCOUNT_STATUSES, 'unbound'])
    status.props.onValueChange?.('blocked')
    group.props.onValueChange?.('work')
    const search = components(page.render(), Input).find(
      (node) => node.props['aria-label'] === '搜索窗口',
    )!
    search.props.onChange?.({
      target: { value: 'TARGET' },
    } as ChangeEvent<HTMLInputElement>)
    expect(visibleWindowNames(page.render())).toEqual(['second', 'first'])

    filterControl(page.render(), '筛选账号状态').props.onValueChange?.('all')
    expect(visibleWindowNames(page.render())).toEqual(['fifth', 'second', 'first'])
    filterControl(page.render(), '筛选账号状态').props.onValueChange?.('blocked')
    filterControl(page.render(), '筛选分组').props.onValueChange?.('ungrouped')
    expect(visibleWindowNames(page.render())).toEqual(['sixth'])
    filterControl(page.render(), '筛选分组').props.onValueChange?.('all')
    expect(visibleWindowNames(page.render())).toEqual(['sixth', 'second', 'first'])
  })

  it('filters every account status and treats only windows with no binding as unbound', async () => {
    state.accounts = ACCOUNT_STATUSES.map((status) =>
      account({ id: status, account: `${status}@example.com`, status }),
    )
    state.windows = [
      ...ACCOUNT_STATUSES.map((status) => profile(status)),
      profile('unbound'),
      profile('deleted'),
      profile('summary-only'),
      profile('wrong-summary'),
    ]
    state.bindings = [
      ...state.accounts.map((item) => bind(item.id, item)),
      { ...bind('deleted', account({ id: 'deleted' })), account: null },
      bind('summary-only', account({ id: 'summary', status: 'blocked' })),
      { ...bind('wrong-summary', account({ status: 'blocked' })), accountId: 'missing' },
    ]
    const page = await mountedPage()
    for (const status of ACCOUNT_STATUSES) {
      filterControl(page.render(), '筛选账号状态').props.onValueChange?.(status)
      expect(visibleWindowNames(page.render())).toEqual(
        status === 'blocked' ? ['blocked', 'summary-only'] : [status],
      )
    }
    const fallbackName = elements(page.render()).find(
      (node) => node.type === 'strong' && node.props.children === 'shared@example.com',
    )
    expect(fallbackName?.props.className).toBe('text-destructive')
    expect(
      components(page.render(), Badge).filter(
        (node) => node.props.variant === 'destructive' && node.props.children === '封禁',
      ),
    ).toHaveLength(2)
    filterControl(page.render(), '筛选账号状态').props.onValueChange?.('unbound')
    expect(visibleWindowNames(page.render())).toEqual(['unbound'])
    filterControl(page.render(), '筛选账号状态').props.onValueChange?.('all')
    expect(visibleWindowNames(page.render())).toEqual(
      state.windows.map((item) => item.name),
    )
  })

  it('uses current accounts for filtering and styling ahead of stale or absent summaries', async () => {
    state.accounts[1] = account({
      id: 'other',
      account: 'other@example.com',
      status: 'blocked',
    })
    state.bindings = [
      bind('first', account({ status: 'blocked' })),
      { ...bind('second', account()), account: null },
      bind('third', account({ id: 'other', account: 'stale@example.com' })),
    ]
    const page = await mountedPage()
    expect(
      elements(page.render())
        .filter(
          (node) => node.type === 'strong' && node.props.className === 'text-destructive',
        )
        .map((node) => node.props.children),
    ).toEqual(['other@example.com'])
    filterControl(page.render(), '筛选账号状态').props.onValueChange?.('blocked')
    expect(visibleWindowNames(page.render())).toEqual(['third'])
    filterControl(page.render(), '筛选账号状态').props.onValueChange?.('active')
    expect(visibleWindowNames(page.render())).toEqual(['first', 'second'])
    filterControl(page.render(), '筛选账号状态').props.onValueChange?.('unbound')
    expect(visibleWindowNames(page.render())).toEqual([])
  })

  it('immediately refilters all linked rows after editing and removes red styling on recovery', async () => {
    const page = await mountedPage()
    filterControl(page.render(), '筛选账号状态').props.onValueChange?.('active')
    editFromCell(page.render())
    const editor = editorSession(components(page.render(), AccountEditor)[0]!.props)
    editor.select('blocked', 'active')
    editor.submit()
    await vi.waitFor(() => {
      expect(visibleWindowNames(page.render())).toEqual(['third'])
      expect(components(page.render(), AccountEditor)).toHaveLength(0)
    })
    filterControl(page.render(), '筛选账号状态').props.onValueChange?.('blocked')
    expect(visibleWindowNames(page.render())).toEqual(['first', 'second'])
    expect(
      components(page.render(), Badge).filter(
        (node) => node.props.variant === 'destructive',
      ),
    ).toHaveLength(2)
    editFromCell(page.render())
    const recovery = editorSession(components(page.render(), AccountEditor)[0]!.props)
    state.saved = account({ status: 'pending' })
    recovery.select('pending', 'blocked')
    recovery.submit()
    await vi.waitFor(() => expect(visibleWindowNames(page.render())).toEqual([]))
    filterControl(page.render(), '筛选账号状态').props.onValueChange?.('pending')
    expect(visibleWindowNames(page.render())).toEqual(['first', 'second'])
    expect(
      elements(page.render()).some(
        (node) => node.type === 'strong' && node.props.className === 'text-destructive',
      ),
    ).toBe(false)
    expect(
      components(page.render(), Badge)
        .filter((node) => node.props.children === '待验证')
        .map((node) => node.props.variant),
    ).toEqual(['outline', 'outline'])
  })

  it('keeps filtering disabled while account data is still loading', async () => {
    let resolveList!: (value: AccountList) => void
    state.listResponse = new Promise((resolve) => {
      resolveList = resolve
    })
    const page = await mountedPage(false)
    expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(true)
    expect(visibleWindowNames(page.render())).toEqual(['first', 'second', 'third'])
    resolveList({
      items: state.accounts,
      bindings: state.bindings,
      total: state.accounts.length,
      storageDurable: true,
    })
    await vi.waitFor(() => {
      expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(false)
    })
    filterControl(page.render(), '筛选账号状态').props.onValueChange?.('unbound')
    expect(visibleWindowNames(page.render())).toEqual([])
  })

  it.each(['accounts', 'bindings'] as const)(
    'does not treat a failed %s load as unbound and recovers on refresh',
    async (source) => {
      if (source === 'accounts') state.listError = new Error('账号读取失败')
      else state.bindingsError = new Error('关联读取失败')
      const page = await mountedPage()
      expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(true)
      expect(visibleWindowNames(page.render())).toEqual(['first', 'second', 'third'])
      state.listError = null
      state.bindingsError = null
      const refresh = components(page.render(), Button).find((node) =>
        Children.toArray(node.props.children).includes('刷新'),
      )!
      refresh.props.onClick?.({} as never)
      await vi.waitFor(() => {
        expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(false)
      })
      filterControl(page.render(), '筛选账号状态').props.onValueChange?.('unbound')
      expect(visibleWindowNames(page.render())).toEqual([])
    },
  )

  it.each(['blocked', 'unbound'])(
    'suspends a %s filter when the plugin stops and reloads before restoring it',
    async (selection) => {
      const intervals = vi.spyOn(globalThis, 'setInterval')
      state.accounts[0] = account({ status: 'blocked' })
      state.windows.push(profile('unbound'))
      const page = await mountedPage()
      const poll = intervals.mock.calls.find(([, delay]) => delay === 3000)![0]
      expect(typeof poll).toBe('function')
      filterControl(page.render(), '筛选账号状态').props.onValueChange?.(selection)
      expect(visibleWindowNames(page.render())).toEqual(
        selection === 'blocked' ? ['first', 'second'] : ['unbound'],
      )

      state.plugin = { ...state.plugin!, state: 'retrying' }
      if (typeof poll === 'function') poll()
      await vi.waitFor(() => {
        const control = filterControl(page.render(), '筛选账号状态')
        expect(control.props.disabled).toBe(true)
        expect(control.props.value).toBe('all')
      })
      expect(visibleWindowNames(page.render())).toEqual([
        'first',
        'second',
        'third',
        'unbound',
      ])
      expect(components(page.render(), AccountSmsPopover)).toHaveLength(0)
      expect(
        components(page.render(), Badge).some((node) => node.props.children === '封禁'),
      ).toBe(false)

      let resolveList!: (value: AccountList) => void
      state.listResponse = new Promise((resolve) => {
        resolveList = resolve
      })
      state.plugin = { ...state.plugin!, state: 'running' }
      if (typeof poll === 'function') poll()
      await vi.waitFor(() => {
        page.render()
        expect(
          state.calls.filter((call) => call.method === 'vinted.accounts.list'),
        ).toHaveLength(2)
      })
      expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(true)
      expect(components(page.render(), AccountSmsPopover)).toHaveLength(0)
      resolveList({
        items: [account({ status: 'pending' }), state.accounts[1]!],
        bindings: state.bindings,
        total: 2,
        storageDurable: true,
      })
      await vi.waitFor(() => {
        expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(false)
      })
      expect(filterControl(page.render(), '筛选账号状态').props.value).toBe(selection)
      expect(visibleWindowNames(page.render())).toEqual(
        selection === 'blocked' ? [] : ['unbound'],
      )
      filterControl(page.render(), '筛选账号状态').props.onValueChange?.('pending')
      expect(visibleWindowNames(page.render())).toEqual(['first', 'second'])
    },
  )

  it('disables stale status filtering if the plugin catalogue cannot be read', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval')
    state.accounts[0] = account({ status: 'blocked' })
    const page = await mountedPage()
    filterControl(page.render(), '筛选账号状态').props.onValueChange?.('blocked')
    state.pluginError = new Error('插件目录不可用')
    const poll = intervals.mock.calls.find(([, delay]) => delay === 3000)![0]
    if (typeof poll === 'function') poll()
    await vi.waitFor(() => {
      expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(true)
    })
    expect(visibleWindowNames(page.render())).toEqual(['first', 'second', 'third'])
    expect(
      elements(page.render()).some(
        (node) => node.type === 'strong' && node.props.className === 'text-destructive',
      ),
    ).toBe(false)
  })
})

describe('account refresh consistency', () => {
  it('shows unavailable data instead of Add and blocks account actions after a failed refresh', async () => {
    state.windows.push(profile('unbound'))
    const page = await mountedPage()
    expect(localComponents(page.render(), 'AccountQuickAdd')).toHaveLength(1)
    const unlink = unlinkButtons(page.render())[0]!
    const unbind = components(page.render(), DropdownMenuItem).find((node) =>
      Children.toArray(node.props.children).includes('解除关联'),
    )!
    editFromCell(page.render())
    const editor = components(page.render(), AccountEditor)[0]!
    state.listError = new Error('账号读取失败')
    refreshButton(page.render()).props.onClick?.({} as never)
    await vi.waitFor(() => {
      expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(true)
    })
    const unavailable = page.render()
    expect(localComponents(unavailable, 'AccountQuickAdd')).toHaveLength(0)
    expect(
      elements(unavailable).filter(
        (node) => node.type === 'span' && node.props.children === '账号资料暂不可用',
      ),
    ).toHaveLength(4)
    expect(
      components(unavailable, Button)
        .filter((node) => node.props['aria-label']?.startsWith('更多操作 '))
        .every((node) => node.props.disabled),
    ).toBe(true)
    expect(
      components(unavailable, DropdownMenuItem).every((node) => node.props.disabled),
    ).toBe(true)
    expect(components(unavailable, AccountEditor)[0]!.props.ready).toBe(false)
    expect(components(unavailable, AccountSmsPopover)).toHaveLength(0)

    const calls = state.calls.length
    unlink.props.onClick?.({} as never)
    unbind.props.onSelect?.({} as Event)
    await expect(editor.props.onSave(account())).rejects.toThrow('账号资料暂不可用')
    expect(state.calls).toHaveLength(calls)
    expect(components(page.render(), AccountEditor)).toHaveLength(1)
  })

  it('disables an open binding dialog and duplicate confirmation when account data becomes unavailable', async () => {
    const page = await mountedPage()
    const change = components(page.render(), DropdownMenuItem).find((node) =>
      Children.toArray(node.props.children).includes('更换账号'),
    )!
    change.props.onSelect?.({} as Event)
    const dialog = localComponents(page.render(), 'AccountBindDialog')[0]!
    const BindingDialog = dialog.type as (props: Record<string, unknown>) => ReactElement
    const binding = harness()
    binding.render(() => BindingDialog(dialog.props))
    const confirm = dialog.props.onConfirm as (id: string) => void
    state.bindResponse = { bound: false, duplicates: ['third'] }
    confirm('other')
    await vi.waitFor(() => {
      expect(
        components(page.render(), AlertDialogAction).some(
          (node) => node.props.children === '仍然关联',
        ),
      ).toBe(true)
    })
    const duplicate = components(page.render(), AlertDialogAction).find(
      (node) => node.props.children === '仍然关联',
    )!
    state.bindingsError = new Error('关联读取失败')
    refreshButton(page.render()).props.onClick?.({} as never)
    await vi.waitFor(() => {
      expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(true)
    })
    const unavailable = localComponents(page.render(), 'AccountBindDialog')[0]!
    expect(unavailable.props.ready).toBe(false)
    expect(unavailable.props.accounts).toEqual([])
    const content = binding.render(() => BindingDialog(unavailable.props))
    const submit = components(content, Button).find(
      (node) => node.props.children === '关联',
    )!
    expect(submit.props.disabled).toBe(true)
    expect(
      components(page.render(), AlertDialogAction).find(
        (node) => node.props.children === '仍然关联',
      )!.props.disabled,
    ).toBe(true)
    const calls = state.calls.length
    submit.props.onClick?.({} as never)
    confirm('other')
    duplicate.props.onClick?.({ preventDefault: () => undefined } as never)
    expect(state.calls).toHaveLength(calls)
  })

  it('rereads a refresh snapshot taken before a status edit without restoring old filter membership', async () => {
    const page = await mountedPage()
    const snapshot = accountSnapshot()
    const stale = deferred<AccountList>()
    state.listResponse = stale.promise
    filterControl(page.render(), '筛选账号状态').props.onValueChange?.('active')
    refreshButton(page.render()).props.onClick?.({} as never)
    await vi.waitFor(() => expect(accountReadCount()).toBe(2))
    editFromCell(page.render())
    const editor = editorSession(components(page.render(), AccountEditor)[0]!.props)
    editor.select('blocked', 'active')
    editor.submit()
    await vi.waitFor(() => {
      expect(visibleWindowNames(page.render())).toEqual(['third'])
    })

    state.accounts = [state.saved!, state.accounts[1]!]
    const fresh = deferred<AccountList>()
    state.listResponse = fresh.promise
    stale.resolve(snapshot)
    await vi.waitFor(() => expect(accountReadCount()).toBe(3))
    expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(false)
    expect(visibleWindowNames(page.render())).toEqual(['third'])
    filterControl(page.render(), '筛选账号状态').props.onValueChange?.('blocked')
    expect(visibleWindowNames(page.render())).toEqual(['first', 'second'])
    fresh.resolve(accountSnapshot())
    await vi.waitFor(() =>
      expect(refreshButton(page.render()).props.disabled).toBe(false),
    )
    expect(
      components(page.render(), AccountSmsPopover).map((node) => node.props.account),
    ).toEqual([state.saved, state.saved])
  })

  it('retries a stale read failure after a completed mutation instead of hiding the saved account', async () => {
    const page = await mountedPage()
    const stale = deferred<AccountList>()
    state.listResponse = stale.promise
    refreshButton(page.render()).props.onClick?.({} as never)
    await vi.waitFor(() => expect(accountReadCount()).toBe(2))
    editFromCell(page.render())
    await components(page.render(), AccountEditor)[0]!.props.onSave(
      account({ status: 'blocked' }),
    )
    state.accounts = [state.saved!, state.accounts[1]!]
    state.listResponse = null
    stale.reject(new Error('过期请求失败'))
    await vi.waitFor(() =>
      expect(refreshButton(page.render()).props.disabled).toBe(false),
    )
    expect(accountReadCount()).toBe(3)
    expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(false)
    expect(components(page.render(), FieldError)).toHaveLength(0)
    expect(
      components(page.render(), AccountSmsPopover).map(
        (node) => node.props.account.status,
      ),
    ).toEqual(['blocked', 'blocked', 'active'])
  })

  it('preserves both completed phone unlinks when their saves finish out of order during a refresh', async () => {
    const page = await mountedPage()
    const snapshot = accountSnapshot()
    const stale = deferred<AccountList>()
    state.listResponse = stale.promise
    refreshButton(page.render()).props.onClick?.({} as never)
    await vi.waitFor(() => expect(accountReadCount()).toBe(2))
    state.listResponse = null
    const firstSave = deferred<{ item: Account; created: boolean }>()
    const secondSave = deferred<{ item: Account; created: boolean }>()
    state.saveResponse = firstSave.promise
    unlinkButtons(page.render())[0]!.props.onClick?.({} as never)
    await vi.waitFor(() => {
      expect(
        state.calls.filter((call) => call.method === 'vinted.accounts.save'),
      ).toHaveLength(1)
    })
    state.saveResponse = secondSave.promise
    unlinkButtons(page.render(), 'other@example.com')[0]!.props.onClick?.({} as never)
    await vi.waitFor(() => {
      expect(
        state.calls.filter((call) => call.method === 'vinted.accounts.save'),
      ).toHaveLength(2)
    })
    const savedFirst = account({ phone: '', smsOtpUrl: '' })
    const savedSecond = { ...state.accounts[1]!, phone: '', smsOtpUrl: '' }
    secondSave.resolve({ item: savedSecond, created: false })
    await vi.waitFor(() => {
      expect(unlinkButtons(page.render(), 'other@example.com')).toHaveLength(0)
    })
    firstSave.resolve({ item: savedFirst, created: false })
    await vi.waitFor(() => expect(unlinkButtons(page.render())).toHaveLength(0))
    state.accounts = [savedFirst, savedSecond]
    stale.resolve(snapshot)
    await vi.waitFor(() =>
      expect(refreshButton(page.render()).props.disabled).toBe(false),
    )
    expect(accountReadCount()).toBe(5)
    expect(
      components(page.render(), AccountSmsPopover).map((node) => node.props.account),
    ).toEqual([savedFirst, savedFirst, savedSecond])
    expect(
      components(page.render(), AccountPhoneCopy).map((node) => node.props.account.phone),
    ).toEqual(['', '', ''])
    expect(state.calls.some((call) => call.method === 'vinted.accounts.unbind')).toBe(
      false,
    )
  })

  it.each(['success', 'failure'] as const)(
    'ignores a late refresh %s across a plugin restart',
    async (result) => {
      const intervals = vi.spyOn(globalThis, 'setInterval')
      const page = await mountedPage()
      const poll = intervals.mock.calls.find(([, delay]) => delay === 3000)![0]
      const snapshot = accountSnapshot()
      const stale = deferred<AccountList>()
      state.listResponse = stale.promise
      refreshButton(page.render()).props.onClick?.({} as never)
      await vi.waitFor(() => expect(accountReadCount()).toBe(2))
      state.plugin = { ...state.plugin!, state: 'retrying' }
      if (typeof poll === 'function') poll()
      await vi.waitFor(() => {
        expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(true)
      })
      const fresh = deferred<AccountList>()
      state.listResponse = fresh.promise
      state.plugin = { ...state.plugin!, state: 'running' }
      if (typeof poll === 'function') poll()
      await vi.waitFor(() => {
        page.render()
        expect(accountReadCount()).toBe(3)
      })
      if (result === 'success') {
        stale.resolve(snapshot)
        await vi.waitFor(() =>
          expect(refreshButton(page.render()).props.disabled).toBe(false),
        )
        expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(true)
        expect(localComponents(page.render(), 'AccountQuickAdd')).toHaveLength(0)
      }
      const recovered = account({ phone: '', smsOtpUrl: '', status: 'pending' })
      fresh.resolve(accountSnapshot([recovered, state.accounts[1]!]))
      await vi.waitFor(() => {
        expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(false)
      })
      if (result === 'failure') {
        stale.reject(new Error('旧插件请求失败'))
        await vi.waitFor(() =>
          expect(refreshButton(page.render()).props.disabled).toBe(false),
        )
      }
      expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(false)
      expect(
        components(page.render(), AccountSmsPopover).map((node) => node.props.account),
      ).toEqual([recovered, recovered, state.accounts[1]])
      expect(components(page.render(), FieldError)).toHaveLength(0)
    },
  )

  it('reloads after plugin availability changes even if no render occurs between transitions', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const page = await mountedPage()
    const poll = intervals.mock.calls.find(([, delay]) => delay === 3000)![0]
    state.plugin = { ...state.plugin!, state: 'retrying' }
    if (typeof poll === 'function') poll()
    await Promise.resolve()
    const fresh = deferred<AccountList>()
    state.listResponse = fresh.promise
    state.plugin = { ...state.plugin!, state: 'running' }
    if (typeof poll === 'function') poll()
    await Promise.resolve()
    await vi.waitFor(() => {
      expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(true)
      expect(accountReadCount()).toBe(2)
    })
    const recovered = account({ status: 'limited' })
    fresh.resolve(accountSnapshot([recovered, state.accounts[1]!]))
    await vi.waitFor(() => {
      expect(filterControl(page.render(), '筛选账号状态').props.disabled).toBe(false)
    })
    filterControl(page.render(), '筛选账号状态').props.onValueChange?.('limited')
    expect(visibleWindowNames(page.render())).toEqual(['first', 'second'])
  })
})

describe('quick account phone unlinking', () => {
  it('clears both contact fields from every linked row using the latest account', async () => {
    const page = await mountedPage()
    const buttons = unlinkButtons(page.render())
    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.props.title).toContain('所有关联窗口')
    expect(buttons[0]!.props.title).toContain('保留 SIM8 号码池')
    const latest = account({
      password: ' newer example password ',
      loginMethod: 'google',
      status: 'pending',
      note: 'updated elsewhere',
      emailOtpUrl: 'https://mail.example.com/latest',
    })
    state.accounts = [latest, state.accounts[1]!]
    state.saved = {
      ...latest,
      phone: '',
      smsOtpUrl: '',
      updatedAt: '2026-10-26T00:00:00.000Z',
    }
    buttons[0]!.props.onClick?.({} as never)

    await vi.waitFor(() => expect(unlinkButtons(page.render())).toHaveLength(0))
    const popovers = components(page.render(), AccountSmsPopover)
    expect(popovers.map((node) => node.props.account)).toEqual([
      state.saved,
      state.saved,
      state.accounts[1],
    ])
    expect(
      components(page.render(), AccountPhoneCopy).map((node) => node.props.account.phone),
    ).toEqual(['', '', state.accounts[1]!.phone])
    expect(unlinkButtons(page.render(), 'other@example.com')).toHaveLength(1)
    expect(state.calls.map((call) => call.method)).toEqual([
      'vinted.accounts.bindings',
      'vinted.accounts.list',
      'vinted.accounts.list',
      'vinted.accounts.save',
    ])
    expect(
      state.calls.find((call) => call.method === 'vinted.accounts.save')?.input,
    ).toEqual({
      id: latest.id,
      account: latest.account,
      loginMethod: latest.loginMethod,
      password: latest.password,
      status: latest.status,
      note: latest.note,
      homepageUrl: latest.homepageUrl,
      emailOtpUrl: latest.emailOtpUrl,
      phone: '',
      smsOtpUrl: '',
    })
    expect(
      components(page.render(), Badge).filter((node) => node.props.children === '待验证'),
    ).toHaveLength(2)
    editFromCell(page.render())
    const editor = components(page.render(), AccountEditor)[0]!
    expect(editor.props.description).toContain('2 个窗口')
    expect(editor.props.account).toEqual(state.saved)
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('手机号与短信接码链接已解绑')

    const sms = harness()
    const smsTree = sms.render(() => AccountSmsPopover(popovers[0]!.props))
    sms.flushEffects()
    const read = components(smsTree, Button).find((node) =>
      Children.toArray(node.props.children).includes('读取短信验证码'),
    )
    expect(read?.props.disabled).toBe(true)
    read?.props.onClick?.({} as never)
    expect(state.calls.some((call) => call.method === 'vinted.accounts.otp')).toBe(false)
  })

  it('shares pending state across linked rows, blocks duplicate clicks, and keeps phone copying', async () => {
    const page = await mountedPage()
    let resolveSave!: (value: { item: Account; created: boolean }) => void
    state.saveResponse = new Promise((resolve) => {
      resolveSave = resolve
    })
    const buttons = unlinkButtons(page.render())
    buttons[0]!.props.onClick?.({} as never)
    buttons[0]!.props.onClick?.({} as never)
    buttons[1]!.props.onClick?.({} as never)
    await vi.waitFor(() => {
      expect(
        state.calls.filter((call) => call.method === 'vinted.accounts.save'),
      ).toHaveLength(1)
    })
    const pending = page.render()
    expect(unlinkButtons(pending).map((node) => node.props.disabled)).toEqual([
      true,
      true,
    ])
    expect(unlinkButtons(pending).map((node) => node.props['aria-busy'])).toEqual([
      true,
      true,
    ])
    expect(unlinkButtons(pending, 'other@example.com')[0]!.props.disabled).toBe(false)
    expect(
      components(pending, AccountSmsPopover).map((node) => node.props.ready),
    ).toEqual([false, false, true])
    const accountEdits = components(pending, Button).filter(
      (node) => node.props['aria-label'] === '编辑 shared@example.com 的账号资料',
    )
    expect(accountEdits.map((node) => node.props.disabled)).toEqual([true, true])
    const menuEdits = components(pending, DropdownMenuItem).filter((node) =>
      Children.toArray(node.props.children).includes('编辑账号资料'),
    )
    expect(menuEdits.map((node) => node.props.disabled)).toEqual([true, true, false])
    const copies = components(pending, AccountPhoneCopy)
    expect(copies[0]!.props.account).toEqual(account())
    const copyMarkup = renderToStaticMarkup(
      createElement(AccountPhoneCopy, copies[0]!.props),
    )
    expect(copyMarkup).toContain('复制 shared@example.com 的手机号 +14155550100')
    expect(copyMarkup).not.toContain('disabled=""')
    expect(toast.success).not.toHaveBeenCalled()

    resolveSave({ item: account({ phone: '', smsOtpUrl: '' }), created: false })
    await vi.waitFor(() => expect(unlinkButtons(page.render())).toHaveLength(0))
    expect(
      components(page.render(), AccountSmsPopover).map((node) => node.props.ready),
    ).toEqual([true, true, true])
  })

  it.each(['lookup', 'save'] as const)(
    'keeps the previous phone and link after a failed %s and allows retry',
    async (stage) => {
      const page = await mountedPage()
      if (stage === 'lookup') state.listError = new Error('账号读取失败')
      else state.saveError = new Error('账号写入失败')
      unlinkButtons(page.render())[0]!.props.onClick?.({} as never)
      await vi.waitFor(() => {
        expect(toast.error).toHaveBeenCalledExactlyOnceWith(
          `解绑手机号失败：${stage === 'lookup' ? '账号读取失败' : '账号写入失败'}`,
        )
        expect(unlinkButtons(page.render()).every((node) => !node.props.disabled)).toBe(
          true,
        )
      })
      expect(
        components(page.render(), AccountSmsPopover).map((node) => node.props.account),
      ).toEqual([account(), account(), state.accounts[1]])
      expect(toast.success).not.toHaveBeenCalled()
      if (stage === 'lookup') {
        expect(state.calls.some((call) => call.method === 'vinted.accounts.save')).toBe(
          false,
        )
      }
      state.listError = null
      state.saveError = null
      state.saved = account({ phone: '', smsOtpUrl: '' })
      unlinkButtons(page.render())[1]!.props.onClick?.({} as never)
      await vi.waitFor(() => expect(unlinkButtons(page.render())).toHaveLength(0))
      expect(toast.success).toHaveBeenCalledExactlyOnceWith('手机号与短信接码链接已解绑')
    },
  )

  it('offers no unlink action without a phone or a ready plugin', async () => {
    state.accounts = state.accounts.map((item) => ({ ...item, phone: '' }))
    const page = await mountedPage()
    expect(unlinkButtons(page.render())).toHaveLength(0)
    expect(unlinkButtons(page.render(), 'other@example.com')).toHaveLength(0)
    state.accounts = [account(), account({ id: 'other', account: 'other@example.com' })]
    state.plugin = { ...state.plugin!, state: 'retrying' }
    state.calls = []
    const unavailable = await mountedPage()
    expect(unlinkButtons(unavailable.render())).toHaveLength(0)
    expect(state.calls).toHaveLength(0)
  })
})

describe('linked Vinted account editing', () => {
  it('opens the shared full editor from the account cell and the row menu', async () => {
    const page = await mountedPage()
    editFromCell(page.render())
    const cellEditor = components(page.render(), AccountEditor)[0]!
    expect(cellEditor.props.account).toEqual(account())
    expect(cellEditor.props.description).toContain('2 个窗口')
    cellEditor.props.onCancel()
    expect(components(page.render(), AccountEditor)).toHaveLength(0)

    const menu = components(page.render(), DropdownMenuItem).filter((node) =>
      Children.toArray(node.props.children).includes('编辑账号资料'),
    )
    expect(menu).toHaveLength(3)
    expect(menu[1]!.props.disabled).toBe(false)
    menu[1]!.props.onSelect?.({} as Event)
    const menuEditor = components(page.render(), AccountEditor)[0]!
    expect(menuEditor.props.account).toEqual(account())

    const editor = editorSession(menuEditor.props)
    expect(components(editor.render(), Input).map((node) => node.props.id)).toEqual([
      'account-name',
      'account-password',
      'account-phone',
      'account-homepage',
      'account-email-otp',
      'account-sms-otp',
      'account-note',
    ])
    expect(
      components(editor.render(), Input).find(
        (node) => node.props.id === 'account-password',
      )?.props.type,
    ).toBe('password')
  })

  it('saves status without changing credentials or bindings and updates every shared row', async () => {
    const page = await mountedPage()
    editFromCell(page.render())
    const editor = editorSession(components(page.render(), AccountEditor)[0]!.props)
    editor.select('blocked', 'active')
    editor.submit()

    await vi.waitFor(() => {
      expect(components(page.render(), AccountEditor)).toHaveLength(0)
    })
    expect(state.calls.filter((call) => call.method === 'vinted.accounts.save')).toEqual([
      {
        method: 'vinted.accounts.save',
        input: {
          id: 'shared',
          loginMethod: 'email',
          account: 'shared@example.com',
          password: '  example password  ',
          phone: '+14155550100',
          emailOtpUrl: 'https://mail.example.com/original',
          smsOtpUrl: 'https://sms.example.com/original',
          note: 'original note',
          homepageUrl: 'https://www.vinted.fr/member/123',
          status: 'blocked',
        },
      },
    ])
    const tree = page.render()
    const summaries = components(tree, Badge).filter(
      (node) => node.props.children === '封禁',
    )
    expect(summaries).toHaveLength(2)
    expect(summaries.every((node) => node.props.variant === 'destructive')).toBe(true)
    expect(
      elements(tree).filter(
        (node) =>
          node.type === 'strong' &&
          node.props.children === 'shared@example.com' &&
          node.props.className === 'text-destructive',
      ),
    ).toHaveLength(2)
    const popovers = components(tree, AccountSmsPopover)
    expect(popovers.map((node) => node.props.account.status)).toEqual([
      'blocked',
      'blocked',
      'active',
    ])
    expect(state.calls.map((call) => call.method)).toEqual([
      'vinted.accounts.bindings',
      'vinted.accounts.list',
      'vinted.accounts.save',
    ])
    expect(state.bindings).toEqual([
      bind('first', account()),
      bind('second', account()),
      bind('third', state.accounts[1]!),
    ])
  })

  it('submits all editable fields and propagates the returned record instead of the draft', async () => {
    const page = await mountedPage()
    editFromCell(page.render())
    const editor = editorSession(components(page.render(), AccountEditor)[0]!.props)
    const draft: AccountInput = {
      id: 'shared',
      loginMethod: 'apple',
      account: 'draft@example.com',
      password: ' new example password ',
      phone: '+442079460000',
      emailOtpUrl: 'https://mail.example.com/new',
      smsOtpUrl: 'https://sms.example.com/new',
      homepageUrl: 'https://www.vinted.fr/member/456',
      note: 'updated note',
      status: 'limited',
    }
    editor.select(draft.loginMethod, 'email')
    editor.select(draft.status, 'active')
    for (const [id, value] of [
      ['account-name', ` ${draft.account} `],
      ['account-password', draft.password],
      ['account-phone', draft.phone],
      ['account-email-otp', draft.emailOtpUrl],
      ['account-sms-otp', draft.smsOtpUrl],
      ['account-homepage', draft.homepageUrl],
      ['account-note', draft.note],
    ] as const) {
      editor.change(id, value)
    }
    state.saved = account({
      ...draft,
      account: 'canonical@example.com',
      phone: '+44 20 7946 0000',
      status: 'pending',
      updatedAt: '2026-10-25T00:00:00.000Z',
    })
    editor.submit()
    await vi.waitFor(() => {
      expect(components(page.render(), AccountEditor)).toHaveLength(0)
    })
    expect(
      state.calls.find((call) => call.method === 'vinted.accounts.save')?.input,
    ).toEqual(draft)
    const tree = page.render()
    expect(components(tree, AccountSmsPopover).map((node) => node.props.account)).toEqual(
      [state.saved, state.saved, state.accounts[1]!],
    )
    expect(
      components(tree, AccountPhoneCopy).map((node) => node.props.account.phone),
    ).toEqual([state.saved.phone, state.saved.phone, state.accounts[1]!.phone])
    expect(
      components(tree, Badge).filter((node) => node.props.children === '待验证'),
    ).toHaveLength(2)
    const edit = components(tree, Button).filter(
      (node) => node.props['aria-label'] === '编辑 canonical@example.com 的账号资料',
    )
    expect(edit).toHaveLength(2)
    edit[1]!.props.onClick?.({} as never)
    expect(components(page.render(), AccountEditor)[0]!.props.account).toEqual(
      state.saved,
    )
  })

  it('keeps the dialog and complete draft after a failed save and supports retry', async () => {
    const page = await mountedPage()
    editFromCell(page.render())
    const editor = editorSession(components(page.render(), AccountEditor)[0]!.props)
    editor.select('blocked', 'active')
    editor.change('account-note', 'keep this draft')
    editor.change('account-sms-otp', '')
    state.saveError = new Error('账号写入失败')
    editor.submit()
    await vi.waitFor(() => {
      expect(components(editor.render(), FieldError)[0]?.props.children).toBe(
        '账号写入失败',
      )
    })
    expect(components(page.render(), AccountEditor)).toHaveLength(1)
    expect(components(page.render(), AccountSmsPopover)[0]!.props.account).toEqual(
      account(),
    )
    expect(
      components(editor.render(), Input).find((node) => node.props.id === 'account-note')
        ?.props.value,
    ).toBe('keep this draft')
    expect(
      components(editor.render(), Input).find(
        (node) => node.props.id === 'account-sms-otp',
      )?.props.value,
    ).toBe('')

    state.saveError = null
    state.saved = account({ status: 'blocked', note: 'keep this draft', smsOtpUrl: '' })
    editor.submit()
    await vi.waitFor(() => {
      expect(components(page.render(), AccountEditor)).toHaveLength(0)
    })
    const writes = state.calls.filter((call) => call.method === 'vinted.accounts.save')
    expect(writes).toHaveLength(2)
    expect(writes[1]!.input).toEqual(writes[0]!.input)
  })

  it('blocks duplicate submission and dismissal until the write settles', async () => {
    const page = await mountedPage()
    editFromCell(page.render())
    const editor = editorSession(components(page.render(), AccountEditor)[0]!.props)
    let resolveSave!: (value: { item: Account; created: boolean }) => void
    state.saveResponse = new Promise((resolve) => {
      resolveSave = resolve
    })
    const initial = editor.render()
    editor.submit(initial)
    editor.submit(initial)
    expect(
      state.calls.filter((call) => call.method === 'vinted.accounts.save'),
    ).toHaveLength(1)
    const content = components(editor.render(), DialogContent)[0]!
    expect(content.props.showCloseButton).toBe(false)
    const preventDefault = vi.fn()
    content.props.onEscapeKeyDown?.({ preventDefault } as unknown as KeyboardEvent)
    content.props.onInteractOutside?.({ preventDefault } as never)
    expect(preventDefault).toHaveBeenCalledTimes(2)
    resolveSave({ item: account(), created: false })
    await vi.waitFor(() => {
      expect(components(page.render(), AccountEditor)).toHaveLength(0)
    })
  })

  it('disables editing before the plugin is ready and preserves a draft when readiness is lost', async () => {
    state.plugin = { ...state.plugin!, state: 'retrying' }
    const page = await mountedPage()
    expect(components(page.render(), AccountEditor)).toHaveLength(0)
    expect(
      components(page.render(), Button).filter((node) =>
        node.props['aria-label']?.endsWith('的账号资料'),
      ),
    ).toHaveLength(0)
    expect(state.calls).toHaveLength(0)

    const onSave = vi.fn(async () => undefined)
    const editor = editorSession({
      account: account(),
      ready: true,
      onSave,
      onCancel: () => undefined,
    })
    editor.change('account-note', 'unsaved while unavailable')
    const unavailable = editor.render({ ready: false })
    expect(
      components(unavailable, Button).find((node) => node.props.type === 'submit')?.props
        .disabled,
    ).toBe(true)
    editor.submit(unavailable)
    expect(onSave).not.toHaveBeenCalled()
    expect(
      components(editor.render(), Input).find((node) => node.props.id === 'account-note')
        ?.props.value,
    ).toBe('unsaved while unavailable')
    editor.submit()
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce())
  })
})
