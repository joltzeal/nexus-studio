import { browserConnection, browserWindow } from '@/lib/platform/browser-test-support'
import {
  listBrowserConnections,
  type BrowserConnection,
} from '@/lib/platform/browser-connections'
import { Sim8ExpiryNotice } from '@/features/sim8/expiry-notice'
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
import { AlertDialog, AlertDialogAction } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs } from '@/components/ui/tabs'
import { Dialog, DialogContent } from '@/components/ui/dialog'
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
  createBrowserWindow,
  deleteBrowserWindow,
  listBrowserWindows,
  listBrowserOperations,
  moveBrowserWindowsGroup,
  reconcileBrowserOperation,
  startBrowserWindow,
  stopBrowserWindow,
  updateBrowserWindow,
  type BrowserWindow,
} from '@/lib/platform/windows'
import type { PluginView } from '@/lib/platform/native-plugins'
import { AccountPhoneCopy, AccountSmsPopover } from './account-sms-popover'
import { ProxyGateDialog } from './proxy-gate'
import { SpacesPage } from './spaces-page'
import { WindowEditor } from './window-editor'
import { BatchWindowDialog } from './batch-window-dialog'
import { TransferToolbar } from './transfer-toolbar'
import { flushPromises } from '@/features/settings/kernel-test-support'
import { checkWindowProxy, type ProxyCheckOutcome } from './window-proxy'

const state = vi.hoisted(() => ({
  hooks: null as HookHarness | null,
  native: false,
  plugin: null as PluginView | null,
  pluginError: null as Error | null,
  accounts: [] as Account[],
  bindings: [] as BindingView[],
  windows: [] as BrowserWindow[],
  connections: [] as BrowserConnection[],
  groups: [] as WindowGroup[],
  calls: [] as { method: string; input: unknown }[],
  saved: null as Account | null,
  listError: null as Error | null,
  bindingsError: null as Error | null,
  listResponse: null as Promise<AccountList> | null,
  saveError: null as Error | null,
  saveResponse: null as Promise<{ item: Account; created: boolean }> | null,
  bindResponse: { bound: true, duplicates: [] as string[] },
  bindPendingResponse: null as Promise<{ bound: boolean; duplicates: string[] }> | null,
  realLaunch: false,
  startingIds: [] as string[],
  profileReadResponse: null as Promise<BrowserWindow[]> | null,
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
    useMemo: <T>(factory: () => T, deps: DependencyList) =>
      state.hooks ? state.hooks.memo(factory(), deps) : react.useMemo(factory, deps),
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
    if (method === 'vinted.accounts.bind')
      return state.bindPendingResponse ?? state.bindResponse
    if (method === 'vinted.accounts.unbind') return { unbound: true }
    throw new Error(`Unexpected account method: ${method}`)
  },
}))

vi.mock('@/lib/platform/windows', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/windows')>()),
  browserWindowsAvailable: () => state.native,
  listBrowserWindows: vi.fn(async () => state.profileReadResponse ?? state.windows),
  startBrowserWindow: vi.fn(async () => undefined),
  stopBrowserWindow: vi.fn(async () => undefined),
  createBrowserWindow: vi.fn(async () => ({
    ...state.windows[0]!,
    id: 'created',
    name: 'created',
  })),
  updateBrowserWindow: vi.fn(async () => undefined),
  moveBrowserWindowsGroup: vi.fn(async (input) => input),
  deleteBrowserWindow: vi.fn(async () => undefined),
  reconcileBrowserOperation: vi.fn(),
  listBrowserOperations: vi.fn(),
}))
vi.mock('@/lib/platform/browser-connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/browser-connections')>()),
  listBrowserConnections: vi.fn(async () => state.connections),
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
            closeGate: () => undefined,
            operatingWindows: new Set(),
            startingWindows: new Set(state.startingIds),
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

let nextSortOrder = 10_000
function profile(id: string, state: BrowserWindow['state'] = 'stopped'): BrowserWindow {
  return browserWindow({ id, name: id, state, sortOrder: nextSortOrder-- })
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
  nextSortOrder = 10_000
  state.native = false
  state.plugin = {
    id: 'studio.vinted-accounts',
    state: 'running',
    enabled: true,
  } as PluginView
  state.accounts = [account(), account({ id: 'other', account: 'other@example.com' })]
  state.windows = [profile('first'), profile('second', 'running'), profile('third')]
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
  state.bindPendingResponse = null
  state.realLaunch = false
  state.startingIds = []
  state.profileReadResponse = null
  vi.mocked(listBrowserWindows)
    .mockReset()
    .mockImplementation(async () => state.profileReadResponse ?? state.windows)
  vi.mocked(startBrowserWindow).mockReset().mockResolvedValue(undefined)
  vi.mocked(stopBrowserWindow).mockReset().mockResolvedValue(undefined)
  vi.mocked(moveBrowserWindowsGroup)
    .mockReset()
    .mockImplementation(async (input) => input)
  vi.mocked(deleteBrowserWindow)
    .mockReset()
    .mockImplementation(async (id) => {
      state.windows = state.windows.filter((window) => window.id !== id)
    })
  vi.mocked(createBrowserWindow)
    .mockReset()
    .mockImplementation(async () => profile('created'))
  vi.mocked(reconcileBrowserOperation).mockReset().mockRejectedValue({
    code: 'operation_failed',
    message: '创建失败',
    retryable: true,
  })
  vi.mocked(listBrowserOperations).mockReset().mockResolvedValue([])
  state.connections = [browserConnection()]
  vi.mocked(listBrowserConnections).mockImplementation(async () => state.connections)
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
    expect(visibleWindowNames(tree)).toHaveLength(
      Math.min(
        20,
        state.windows.filter((window) => window.connectionId === 'builtin').length,
      ),
    )
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
  function createEditor(page: Awaited<ReturnType<typeof mountedPage>>) {
    components(page.render(), Button)
      .find((node) => Children.toArray(node.props.children).includes('创建窗口'))!
      .props.onClick?.({} as never)
    const form = harness()
    const render = () => {
      const props = components(page.render(), WindowEditor)[0]!.props
      return form.render(() => WindowEditor(props))
    }
    return {
      render,
      input(id: string, value: string) {
        components(render(), Input)
          .find((node) => node.props.id === id)!
          .props.onChange?.({ target: { value } } as never)
      },
      select(id: string, value: string) {
        components(render(), Select)
          .find((node) =>
            components(node, SelectTrigger).some((trigger) => trigger.props.id === id),
          )!
          .props.onValueChange?.(value)
      },
      async submit() {
        const submit = elements(render()).find((node) => node.type === 'form')!.props
          .onSubmit as (event: FormEvent) => void
        submit({ preventDefault() {} } as FormEvent)
        await flushPromises()
      },
    }
  }

  it('reuses a generated blank-name and blank-seed intent through the real editor and page', async () => {
    const page = await mountedPage()
    const editor = createEditor(page)
    editor.input('window-seed', '')
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.1)
    try {
      vi.mocked(createBrowserWindow).mockRejectedValueOnce(new Error('response lost'))
      await editor.submit()
      const first = vi.mocked(createBrowserWindow).mock.calls[0]![0]
      expect(first.name).not.toBe('')
      expect(first.settings.fingerprintSeed).not.toBeNull()
      expect(components(editor.render(), FieldError)[0]?.props.children).toBe(
        'response lost',
      )
      random.mockReturnValue(0.9)
      await editor.submit()
      expect(createBrowserWindow).toHaveBeenNthCalledWith(2, first)
      expect(reconcileBrowserOperation).not.toHaveBeenCalled()
      expect(components(page.render(), WindowEditor)).toHaveLength(0)
    } finally {
      random.mockRestore()
    }
  })

  it.each(['http', 'https', 'socks5'])(
    'forwards authenticated manual %s from the external form to create',
    async (protocol) => {
      state.connections.push(browserConnection({ id: 'ads', providerId: 'adspower' }))
      const page = await mountedPage()
      components(page.render(), Tabs)
        .find((node) => node.props.value === 'cloakbrowser')!
        .props.onValueChange?.('adspower')
      const editor = createEditor(page)
      editor.select('window-proxy-source', 'manual')
      editor.select('window-protocol', protocol)
      const proxy = `${protocol}://fixture-user:fixture-pass@proxy.test:1080`
      editor.input('window-proxy', proxy)
      await editor.submit()
      expect(createBrowserWindow).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          connectionId: 'ads',
          operationId: expect.any(String),
          proxyMode: 'manual',
          proxy,
        }),
      )
    },
  )

  it.each(['operation_failed', 'operation_missing', 'operation_uncertain'])(
    'retries %s through create using the same frozen UUID and input',
    async (code) => {
      const page = await mountedPage()
      components(page.render(), Button)
        .find((node) => Children.toArray(node.props.children).includes('创建窗口'))!
        .props.onClick?.({} as never)
      const editor = () => components(page.render(), WindowEditor)[0]!.props
      const input = {
        name: 'fixed',
        proxyMode: 'direct' as const,
        proxy: null,
        proxyPlugin: null,
        proxyEndpoint: null,
        settings: browserWindow().settings,
        groupId: null,
        kernelVersion: null,
      }
      vi.mocked(createBrowserWindow).mockRejectedValueOnce(new Error(code))
      await expect(editor().onSave(input)).rejects.toThrow(code)
      const first = vi.mocked(createBrowserWindow).mock.calls[0]![0]
      const result = browserWindow({ id: 'reserved-uuid', name: 'fixed' })
      vi.mocked(createBrowserWindow).mockResolvedValueOnce(result)
      await editor().onSave(input)
      expect(createBrowserWindow).toHaveBeenNthCalledWith(2, first)
      expect(reconcileBrowserOperation).not.toHaveBeenCalled()
      expect(listBrowserOperations).not.toHaveBeenCalled()
      expect(components(page.render(), WindowEditor)).toHaveLength(0)
      expect(visibleWindowNames(page.render())).toContain('fixed')
    },
  )

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
    expect(html).toContain('全选本页窗口')
    expect(html).toContain('已选 0')
    expect(html).toContain('尚未启用浏览器接入')
  })

  it('forwards the selected kernel only when creating a new window', async () => {
    const page = await mountedPage()
    const create = components(page.render(), Button).find((node) =>
      Children.toArray(node.props.children).includes('创建窗口'),
    )
    expect(create).toBeDefined()
    create?.props.onClick?.({} as never)
    const settings = profile('new').settings
    const input = {
      name: 'new',
      proxyMode: 'direct' as const,
      proxy: null,
      proxyPlugin: null,
      proxyEndpoint: null,
      settings,
      groupId: 'group-1',
      kernelVersion: '155.0.1.2.7',
    }
    await components(page.render(), WindowEditor)[0]!.props.onSave(input)
    expect(createBrowserWindow).toHaveBeenCalledExactlyOnceWith({
      ...input,
      connectionId: 'builtin',
      operationId: expect.any(String),
    })
    const edit = components(page.render(), Button).find(
      (node) => node.props['aria-label'] === '编辑 first',
    )!
    edit.props.onClick?.({} as never)
    const updated = {
      name: 'renamed',
      proxyMode: input.proxyMode,
      proxy: input.proxy,
      proxyPlugin: input.proxyPlugin,
      proxyEndpoint: input.proxyEndpoint,
      settings: input.settings,
      groupId: 'group-2',
    }
    await components(page.render(), WindowEditor)[0]!.props.onSave(updated)
    expect(updateBrowserWindow).toHaveBeenCalledExactlyOnceWith({
      id: 'first',
      ...updated,
    })
    expect(createBrowserWindow).toHaveBeenCalledOnce()
  })

  it.each(['running', 'unknown', 'missing'] as const)(
    'offers local metadata editing while a window is %s',
    async (windowState) => {
      state.windows[0] = { ...state.windows[0]!, state: windowState }
      const page = await mountedPage()
      const edit = components(page.render(), Button).find(
        (node) => node.props['aria-label'] === '编辑 first',
      )!
      expect(edit.props.disabled).toBe(false)
      edit.props.onClick?.({} as never)
      expect(components(page.render(), WindowEditor)[0]!.props.window?.state).toBe(
        windowState,
      )
    },
  )
})

describe('window list pagination', () => {
  beforeEach(() => {
    state.accounts[0] = account({ status: 'blocked' })
    state.windows = Array.from({ length: 66 }, (_, index) => ({
      ...profile(`window-${String(index + 1).padStart(2, '0')}`),
      groupId: index < 5 ? 'group-1' : null,
    }))
    state.bindings = state.windows
      .slice(0, 5)
      .map((window) => bind(window.id, state.accounts[0]!))
    state.windows.reverse()
  })

  function pageButton(tree: ReactNode, label: string) {
    const button = components(tree, Button).find(
      (node) => node.props['aria-label'] === label,
    )
    expect(button, `Missing pagination button: ${label}`).toBeDefined()
    return button!
  }

  function clickPage(page: Awaited<ReturnType<typeof mountedPage>>, label: string) {
    const button = pageButton(page.render(), label)
    expect(button.props.disabled).toBe(false)
    button.props.onClick?.({} as never)
  }

  function pageSelection(tree: ReactNode) {
    return components(tree, Checkbox).find(
      (node) => node.props['aria-label'] === '全选本页窗口',
    )!
  }

  function selectedWindowNames(tree: ReactNode) {
    return components(tree, TransferToolbar)[0]!.props.windows.map(
      (window) => window.name,
    )
  }

  it('splits the newest-first list into bounded pages without duplicates or missing rows', async () => {
    const page = await mountedPage()
    expect(visibleWindowNames(page.render())).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `window-${String(index + 1).padStart(2, '0')}`,
      ),
    )
    expect(pageButton(page.render(), '上一页').props.disabled).toBe(true)
    expect(pageButton(page.render(), '首页').props.disabled).toBe(true)
    clickPage(page, '下一页')
    expect(visibleWindowNames(page.render())).toEqual(
      Array.from({ length: 20 }, (_, index) => `window-${index + 21}`),
    )
    clickPage(page, '末页')
    expect(visibleWindowNames(page.render())).toEqual([
      'window-61',
      'window-62',
      'window-63',
      'window-64',
      'window-65',
      'window-66',
    ])
    expect(pageButton(page.render(), '下一页').props.disabled).toBe(true)
    expect(pageButton(page.render(), '末页').props.disabled).toBe(true)
    clickPage(page, '上一页')
    expect(visibleWindowNames(page.render())[0]).toBe('window-41')
    clickPage(page, '首页')
    expect(visibleWindowNames(page.render())[0]).toBe('window-01')
  })

  it('selects only eligible rows on the current page while preserving selections from other pages and filters', async () => {
    state.windows = state.windows.map((window) =>
      window.id === 'window-02' ? { ...window, state: 'starting' } : window,
    )
    const page = await mountedPage()
    pageSelection(page.render()).props.onCheckedChange?.(true)
    expect(selectedWindowNames(page.render())).toHaveLength(19)
    expect(selectedWindowNames(page.render())).not.toContain('window-02')
    expect(selectedWindowNames(page.render())).not.toContain('window-21')
    clickPage(page, '下一页')
    expect(pageSelection(page.render()).props.checked).toBe(false)
    components(page.render(), Checkbox)
      .find((node) => node.props['aria-label'] === '选择窗口 window-21')!
      .props.onCheckedChange?.(true)
    expect(pageSelection(page.render()).props.checked).toBe('indeterminate')
    clickPage(page, '上一页')
    expect(pageSelection(page.render()).props.checked).toBe(true)
    pageSelection(page.render()).props.onCheckedChange?.(false)
    expect(selectedWindowNames(page.render())).toEqual(['window-21'])
    filterControl(page.render(), '筛选分组').props.onValueChange?.('group-1')
    expect(selectedWindowNames(page.render())).toEqual(['window-21'])
    expect(pageSelection(page.render()).props.checked).toBe(false)
  })

  it.each(['search', 'group', 'account'])(
    'returns to page one when changing the %s filter',
    async (filter) => {
      const page = await mountedPage()
      clickPage(page, '末页')
      if (filter === 'search') {
        components(page.render(), Input)
          .find((node) => node.props['aria-label'] === '搜索窗口')!
          .props.onChange?.({
            target: { value: 'window-0' },
          } as ChangeEvent<HTMLInputElement>)
      } else {
        filterControl(
          page.render(),
          filter === 'group' ? '筛选分组' : '筛选账号状态',
        ).props.onValueChange?.(filter === 'group' ? 'group-1' : 'blocked')
      }
      expect(visibleWindowNames(page.render())[0]).toBe('window-01')
      expect(visibleWindowNames(page.render())).toHaveLength(filter === 'search' ? 9 : 5)
      expect(pageButton(page.render(), '上一页').props.disabled).toBe(true)
    },
  )

  it('resets to the first page when changing page size and keeps the last partial page', async () => {
    const page = await mountedPage()
    clickPage(page, '末页')
    filterControl(page.render(), '每页窗口数').props.onValueChange?.('50')
    expect(visibleWindowNames(page.render())).toHaveLength(50)
    expect(visibleWindowNames(page.render())[0]).toBe('window-01')
    clickPage(page, '下一页')
    expect(visibleWindowNames(page.render())).toHaveLength(16)
    expect(visibleWindowNames(page.render())[0]).toBe('window-51')
    filterControl(page.render(), '每页窗口数').props.onValueChange?.('100')
    expect(visibleWindowNames(page.render())).toHaveLength(66)
    expect(pageButton(page.render(), '下一页').props.disabled).toBe(true)
  })

  it('clamps after deleting the last row on a page and does not restore the invalid page on refresh', async () => {
    state.windows = state.windows.filter((window) => Number(window.name.slice(-2)) <= 21)
    const page = await mountedPage()
    clickPage(page, '下一页')
    components(page.render(), Button)
      .find((node) => node.props['aria-label'] === '删除 window-21')!
      .props.onClick?.({} as never)
    components(page.render(), AlertDialogAction)[0]!.props.onClick?.({
      preventDefault() {},
    } as never)
    await vi.waitFor(() => {
      expect(visibleWindowNames(page.render())).toHaveLength(20)
      expect(visibleWindowNames(page.render())[0]).toBe('window-01')
    })
    state.windows.push({ ...profile('older'), createdAt: 1 })
    components(page.render(), Button)
      .find((node) => Children.toArray(node.props.children).includes('刷新'))!
      .props.onClick?.({} as never)
    await flushPromises()
    expect(visibleWindowNames(page.render())[0]).toBe('window-01')
    expect(pageButton(page.render(), '上一页').props.disabled).toBe(true)
  })

  it.each(['single', 'batch'])(
    'returns to the newest page after %s creation',
    async (kind) => {
      const page = await mountedPage()
      clickPage(page, '末页')
      const saved = { ...profile('created'), createdAt: 20 }
      if (kind === 'single') {
        vi.mocked(createBrowserWindow).mockResolvedValueOnce(saved)
        components(page.render(), Button)
          .find((node) => Children.toArray(node.props.children).includes('创建窗口'))!
          .props.onClick?.({} as never)
        await components(page.render(), WindowEditor)[0]!.props.onSave({
          name: 'created',
          proxyMode: 'direct',
          proxy: null,
          proxyPlugin: null,
          proxyEndpoint: null,
          settings: saved.settings,
          groupId: null,
          kernelVersion: null,
        })
      } else {
        components(page.render(), Button)
          .find((node) => Children.toArray(node.props.children).includes('批量创建'))!
          .props.onClick?.({} as never)
        state.windows.push(saved)
        await components(page.render(), BatchWindowDialog)[0]!.props.onSettled([
          {
            key: '0',
            name: saved.name,
            seed: 42,
            operationId: 'test-create',
            input: null,
            account: null,
            window: saved,
            status: 'complete',
            error: null,
            duplicateWindowIds: [],
          },
        ])
      }
      expect(visibleWindowNames(page.render())[0]).toBe('created')
      expect(pageButton(page.render(), '上一页').props.disabled).toBe(true)
    },
  )

  it('resets pagination and clears selection when switching browser connections', async () => {
    state.connections.push(browserConnection({ id: 'ads', providerId: 'adspower' }))
    state.windows.push(
      ...Array.from({ length: 25 }, (_, index) =>
        browserWindow({
          id: `ads-${index}`,
          name: `ads-${index}`,
          connectionId: 'ads',
          providerId: 'adspower',
          createdAt: 100 - index,
          sortOrder: index,
        }),
      ),
    )
    const page = await mountedPage()
    pageSelection(page.render()).props.onCheckedChange?.(true)
    clickPage(page, '末页')
    components(page.render(), Tabs)
      .find((node) => node.props.value === 'cloakbrowser')!
      .props.onValueChange?.('adspower')
    expect(visibleWindowNames(page.render())[0]).toBe('ads-0')
    expect(visibleWindowNames(page.render())).toHaveLength(20)
    expect(selectedWindowNames(page.render())).toEqual([])
    clickPage(page, '下一页')
    components(page.render(), Tabs)
      .find((node) => node.props.value === 'adspower')!
      .props.onValueChange?.('cloakbrowser')
    expect(visibleWindowNames(page.render())[0]).toBe('window-01')
  })

  it('renders empty results on the first page with both directions disabled', async () => {
    const page = await mountedPage()
    clickPage(page, '末页')
    components(page.render(), Input)
      .find((node) => node.props['aria-label'] === '搜索窗口')!
      .props.onChange?.({
        target: { value: 'no match' },
      } as ChangeEvent<HTMLInputElement>)
    expect(visibleWindowNames(page.render())).toEqual([])
    expect(pageButton(page.render(), '上一页').props.disabled).toBe(true)
    expect(pageButton(page.render(), '下一页').props.disabled).toBe(true)
  })
})

describe('batch window grouping', () => {
  function button(tree: ReactNode, label: string) {
    const found = components(tree, Button).find((node) =>
      Children.toArray(node.props.children).includes(label),
    )
    expect(found, `Missing button: ${label}`).toBeDefined()
    return found!
  }

  function select(tree: ReactNode, name: string) {
    const checkbox = components(tree, Checkbox).find(
      (node) => node.props['aria-label'] === `选择窗口 ${name}`,
    )!
    expect(checkbox.props.disabled).toBe(false)
    checkbox.props.onCheckedChange?.(true)
  }

  function submit(tree: ReactNode) {
    const form = elements(tree).find(
      (node) => node.type === 'form' && node.props['aria-label'] === '批量移动分组',
    )
    expect(form).toBeDefined()
    return (form!.props.onSubmit as (event: FormEvent) => Promise<void>)({
      preventDefault() {},
    } as FormEvent)
  }

  beforeEach(() => {
    state.groups = [
      { id: 'group-1', name: '常用', note: '', windowCount: 2 },
      { id: 'group-2', name: '备用', note: '', windowCount: 0 },
    ]
    state.windows = state.windows.map((window) => ({ ...window, groupId: 'group-1' }))
  })

  it('moves stopped and running windows together without changing browser configuration', async () => {
    const page = await mountedPage()
    expect(button(page.render(), '移动分组').props.disabled).toBe(true)
    select(page.render(), 'first')
    select(page.render(), 'second')
    const before = state.windows.map((window) => ({ ...window }))
    button(page.render(), '移动分组').props.onClick?.({} as never)
    filterControl(page.render(), '目标分组').props.onValueChange?.('group-2')
    await submit(page.render())
    expect(moveBrowserWindowsGroup).toHaveBeenCalledExactlyOnceWith({
      connectionId: 'builtin',
      ids: ['first', 'second'],
      groupId: 'group-2',
    })
    expect(updateBrowserWindow).not.toHaveBeenCalled()
    expect(components(page.render(), TransferToolbar)[0]!.props.windows).toEqual([])
    filterControl(page.render(), '筛选分组').props.onValueChange?.('group-2')
    expect(visibleWindowNames(page.render())).toEqual(['first', 'second'])
    filterControl(page.render(), '筛选分组').props.onValueChange?.('group-1')
    expect(visibleWindowNames(page.render())).toEqual(['third'])
    expect(state.windows).toEqual(before)
    expect(toast.success).toHaveBeenCalledWith('已移动 2 个窗口')
  })

  it('keeps a frozen cross-page selection and supports moving to ungrouped', async () => {
    state.windows = Array.from({ length: 25 }, (_, index) => ({
      ...profile(`window-${index + 1}`),
      groupId: 'group-1',
    }))
    const page = await mountedPage()
    select(page.render(), 'window-1')
    components(page.render(), Button)
      .find((node) => node.props['aria-label'] === '下一页')!
      .props.onClick?.({} as never)
    select(page.render(), 'window-21')
    button(page.render(), '移动分组').props.onClick?.({} as never)
    filterControl(page.render(), '目标分组').props.onValueChange?.('ungrouped')
    await submit(page.render())
    expect(moveBrowserWindowsGroup).toHaveBeenCalledExactlyOnceWith({
      connectionId: 'builtin',
      ids: ['window-1', 'window-21'],
      groupId: null,
    })
    filterControl(page.render(), '筛选分组').props.onValueChange?.('ungrouped')
    expect(visibleWindowNames(page.render())).toEqual(['window-1', 'window-21'])
  })

  it('preserves the dialog, destination and selection on an atomic move failure', async () => {
    const page = await mountedPage()
    select(page.render(), 'first')
    button(page.render(), '移动分组').props.onClick?.({} as never)
    filterControl(page.render(), '目标分组').props.onValueChange?.('group-2')
    vi.mocked(moveBrowserWindowsGroup).mockRejectedValueOnce(new Error('分组不存在'))
    await submit(page.render())
    expect(filterControl(page.render(), '目标分组').props.value).toBe('group-2')
    expect(
      components(page.render(), FieldError).some(
        (node) => node.props.children === '分组不存在',
      ),
    ).toBe(true)
    expect(components(page.render(), TransferToolbar)[0]!.props.windows).toHaveLength(1)
    expect(toast.success).not.toHaveBeenCalled()
    await submit(page.render())
    filterControl(page.render(), '筛选分组').props.onValueChange?.('group-2')
    expect(visibleWindowNames(page.render())).toEqual(['first'])
  })

  it('prevents duplicate submissions and closing the dialog while a move is pending', async () => {
    let resolve!: (input: {
      connectionId: string
      ids: string[]
      groupId: string | null
    }) => void
    vi.mocked(moveBrowserWindowsGroup).mockReturnValueOnce(
      new Promise((done) => (resolve = done)),
    )
    const page = await mountedPage()
    select(page.render(), 'first')
    button(page.render(), '移动分组').props.onClick?.({} as never)
    const tree = page.render()
    const pending = submit(tree)
    await submit(tree)
    expect(moveBrowserWindowsGroup).toHaveBeenCalledOnce()
    const dialog = components(page.render(), Dialog).find((node) =>
      elements(node).some((child) => child.props['aria-label'] === '批量移动分组'),
    )!
    dialog.props.onOpenChange?.(false)
    expect(filterControl(page.render(), '目标分组').props.disabled).toBe(true)
    resolve(vi.mocked(moveBrowserWindowsGroup).mock.calls[0]![0])
    await pending
    expect(button(page.render(), '移动分组').props.disabled).toBe(true)
  })

  it('does not clear a new connection selection when an earlier move finishes', async () => {
    state.connections.push(browserConnection({ id: 'ads', providerId: 'adspower' }))
    const other = browserWindow({
      id: 'ads-window',
      name: 'ads-window',
      connectionId: 'ads',
      providerId: 'adspower',
    })
    state.windows.push(other)
    let resolve!: (input: {
      connectionId: string
      ids: string[]
      groupId: string | null
    }) => void
    vi.mocked(moveBrowserWindowsGroup).mockReturnValueOnce(
      new Promise((done) => (resolve = done)),
    )
    const page = await mountedPage()
    select(page.render(), 'first')
    button(page.render(), '移动分组').props.onClick?.({} as never)
    filterControl(page.render(), '目标分组').props.onValueChange?.('group-2')
    const pending = submit(page.render())
    components(page.render(), Tabs)
      .find((node) => node.props.value === 'cloakbrowser')!
      .props.onValueChange?.('adspower')
    select(page.render(), 'ads-window')
    resolve(vi.mocked(moveBrowserWindowsGroup).mock.calls[0]![0])
    await pending
    expect(
      components(page.render(), TransferToolbar)[0]!.props.windows.map((row) => row.id),
    ).toEqual(['ads-window'])
    expect(visibleWindowNames(page.render())).toEqual(['ads-window'])
    expect(toast.success).not.toHaveBeenCalled()
    components(page.render(), Tabs)
      .find((node) => node.props.value === 'adspower')!
      .props.onValueChange?.('cloakbrowser')
    filterControl(page.render(), '筛选分组').props.onValueChange?.('group-2')
    expect(visibleWindowNames(page.render())).toEqual(['first'])
  })

  it('does not allow starting or stopping windows to be newly selected', async () => {
    state.windows[0] = { ...state.windows[0]!, state: 'starting' }
    state.windows[1] = { ...state.windows[1]!, state: 'stopping' }
    const page = await mountedPage()
    const boxes = components(page.render(), Checkbox)
    expect(
      boxes.find((node) => node.props['aria-label'] === '选择窗口 first')!.props.disabled,
    ).toBe(true)
    expect(
      boxes.find((node) => node.props['aria-label'] === '选择窗口 second')!.props
        .disabled,
    ).toBe(true)
    boxes
      .find((node) => node.props['aria-label'] === '全选本页窗口')!
      .props.onCheckedChange?.(true)
    expect(
      components(page.render(), TransferToolbar)[0]!.props.windows.map((row) => row.id),
    ).toEqual(['third'])
  })

  it('uses the same startup guard for row selection, page selection and moving groups', async () => {
    const page = await mountedPage()
    select(page.render(), 'first')
    state.startingIds = ['first']
    expect(button(page.render(), '移动分组').props.disabled).toBe(true)
    expect(
      components(page.render(), Checkbox).find(
        (node) => node.props['aria-label'] === '选择窗口 first',
      )!.props.disabled,
    ).toBe(true)
    button(page.render(), '清除选择').props.onClick?.({} as never)
    components(page.render(), Checkbox)
      .find((node) => node.props['aria-label'] === '全选本页窗口')!
      .props.onCheckedChange?.(true)
    expect(
      components(page.render(), TransferToolbar)[0]!.props.windows.map((row) => row.id),
    ).toEqual(['second', 'third'])
  })

  it('does not let a refresh begun before a successful move restore old memberships', async () => {
    const page = await mountedPage()
    const stale = state.windows
    let finishRead!: (windows: BrowserWindow[]) => void
    vi.mocked(listBrowserWindows).mockReturnValueOnce(
      new Promise((done) => (finishRead = done)),
    )
    refreshButton(page.render()).props.onClick?.({} as never)
    select(page.render(), 'first')
    button(page.render(), '移动分组').props.onClick?.({} as never)
    filterControl(page.render(), '目标分组').props.onValueChange?.('group-2')
    vi.mocked(moveBrowserWindowsGroup).mockImplementationOnce(async (input) => {
      state.windows = state.windows.map((window) =>
        input.ids.includes(window.id) ? { ...window, groupId: input.groupId } : window,
      )
      return input
    })
    await submit(page.render())
    filterControl(page.render(), '筛选分组').props.onValueChange?.('group-2')
    expect(visibleWindowNames(page.render())).toEqual(['first'])
    finishRead(stale)
    await vi.waitFor(() => {
      expect(listBrowserWindows).toHaveBeenCalledTimes(3)
      expect(visibleWindowNames(page.render())).toEqual(['first'])
      expect(refreshButton(page.render()).props.disabled).toBe(false)
    })
  })
})

describe('account binding view guards', () => {
  function openBinding(tree: ReactNode, name: string) {
    components(windowRow(tree, name), DropdownMenuItem)
      .find((node) => Children.toArray(node.props.children).includes('更换账号'))!
      .props.onSelect?.({} as Event)
  }
  function dismissBinding(tree: ReactNode) {
    components(tree, Dialog)
      .find((node) => localComponents(node, 'AccountBindDialog').length > 0)!
      .props.onOpenChange?.(false)
  }
  async function changeView(
    page: Awaited<ReturnType<typeof mountedPage>>,
    change: string,
  ) {
    if (change === 'provider') {
      const tabs = () =>
        components(page.render(), Tabs).find((node) =>
          ['cloakbrowser', 'adspower'].includes(String(node.props.value)),
        )!
      tabs().props.onValueChange?.('adspower')
      tabs().props.onValueChange?.('cloakbrowser')
    } else if (change === 'connection') {
      state.connections = [
        { ...state.connections[0]!, revision: state.connections[0]!.revision + 1 },
      ]
      refreshButton(page.render()).props.onClick?.({} as never)
      await vi.waitFor(() =>
        expect(refreshButton(page.render()).props.disabled).toBe(false),
      )
    }
  }

  it.each(
    ['dismiss', 'provider', 'connection'].flatMap((change) =>
      ['conflict', 'success', 'failure'].map((result) => ({ change, result })),
    ),
  )('ignores late $result dialog updates after $change', async ({ change, result }) => {
    const page = await mountedPage()
    const response = deferred<{ bound: boolean; duplicates: string[] }>()
    state.bindPendingResponse = response.promise
    openBinding(page.render(), 'first')
    const original = localComponents(page.render(), 'AccountBindDialog')[0]!
    ;(original.props.onConfirm as (id: string) => void)('other')
    dismissBinding(page.render())
    await changeView(page, change)
    openBinding(page.render(), 'third')
    const reads = accountReadCount()
    if (result === 'failure') response.reject(new Error('old binding failure'))
    else response.resolve({ bound: result === 'success', duplicates: ['third'] })
    await flushPromises()
    expect(localComponents(page.render(), 'AccountBindDialog')[0]?.props.window).toEqual(
      state.windows[2],
    )
    expect(localComponents(page.render(), 'AccountBindDialog')[0]?.props.error).toBeNull()
    expect(components(page.render(), AlertDialogAction)).toHaveLength(0)
    expect(state.calls.filter((call) => call.method === 'vinted.accounts.bind')).toEqual([
      {
        method: 'vinted.accounts.bind',
        input: { accountId: 'other', windowId: 'first', confirmDuplicates: false },
      },
    ])
    if (result === 'success')
      await vi.waitFor(() => expect(accountReadCount()).toBeGreaterThan(reads))
  })

  it.each(['success', 'failure'])(
    'ignores late duplicate-confirmation %s after dismissal and Tab change',
    async (result) => {
      const page = await mountedPage()
      state.bindResponse = { bound: false, duplicates: ['third'] }
      openBinding(page.render(), 'first')
      const original = localComponents(page.render(), 'AccountBindDialog')[0]!
      ;(original.props.onConfirm as (id: string) => void)('other')
      await vi.waitFor(() =>
        expect(components(page.render(), AlertDialogAction)).toHaveLength(1),
      )
      const response = deferred<{ bound: boolean; duplicates: string[] }>()
      state.bindPendingResponse = response.promise
      components(page.render(), AlertDialogAction)[0]!.props.onClick?.({
        preventDefault() {},
      } as never)
      components(page.render(), AlertDialog)
        .find((node) => node.props.open)!
        .props.onOpenChange?.(false)
      dismissBinding(page.render())
      await changeView(page, 'provider')
      openBinding(page.render(), 'third')
      if (result === 'failure') response.reject(new Error('old conflict failure'))
      else response.resolve({ bound: true, duplicates: [] })
      await flushPromises()
      expect(
        localComponents(page.render(), 'AccountBindDialog')[0]?.props.window,
      ).toEqual(state.windows[2])
      expect(
        localComponents(page.render(), 'AccountBindDialog')[0]?.props.error,
      ).toBeNull()
      expect(
        state.calls.filter((call) => call.method === 'vinted.accounts.bind')[1],
      ).toEqual({
        method: 'vinted.accounts.bind',
        input: { accountId: 'other', windowId: 'first', confirmDuplicates: true },
      })
    },
  )
})

describe('browser connections and global associations', () => {
  async function externalPage() {
    const page = await mountedPage()
    state.connections.push(
      browserConnection({
        id: 'ads',
        providerId: 'adspower',
        name: 'Ads team',
        capabilities: {
          ...browserConnection().capabilities,
          attach: true,
          transfer: false,
          fingerprintSeed: false,
          kernelSelection: false,
        },
      }),
    )
    state.windows.push(
      browserWindow({
        id: 'ads-shop',
        name: 'Ads shop',
        providerId: 'adspower',
        connectionId: 'ads',
        origin: 'attached',
        proxyMode: 'provider',
      }),
    )
    const refresh = components(page.render(), Button).find((node) =>
      Children.toArray(node.props.children).includes('刷新'),
    )!
    refresh.props.onClick?.({} as never)
    await vi.waitFor(() => {
      expect(components(page.render(), Sim8ExpiryNotice)[0]!.props.windows).toHaveLength(
        4,
      )
      expect(
        components(page.render(), Button).find((node) =>
          Children.toArray(node.props.children).includes('刷新'),
        ),
      ).toBeDefined()
    })
    return page
  }
  function selectProvider(tree: ReactNode, provider: string) {
    components(tree, Tabs)
      .find(
        (node) => node.props.value === 'cloakbrowser' || node.props.value === 'adspower',
      )!
      .props.onValueChange?.(provider)
  }

  it('filters only the display while SIM8 and duplicate names retain all windows', async () => {
    const page = await externalPage()
    expect(visibleWindowNames(page.render())).toEqual(['first', 'second', 'third'])
    selectProvider(page.render(), 'adspower')
    expect(visibleWindowNames(page.render())).toEqual(['Ads shop'])
    expect(
      components(page.render(), Sim8ExpiryNotice)[0]!.props.windows.map(
        (window) => window.id,
      ),
    ).toEqual(['first', 'second', 'third', 'ads-shop'])
    expect(
      vi.mocked(listBrowserWindows).mock.calls.every((args) => args.length === 0),
    ).toBe(true)
  })

  it('clears selection and editor on Tab change and restores per-connection filters', async () => {
    const page = await externalPage()
    const select = components(page.render(), Checkbox).find(
      (node) => node.props['aria-label'] === '选择窗口 first',
    )!
    select.props.onCheckedChange?.(true)
    const search = components(page.render(), Input).find(
      (node) => node.props['aria-label'] === '搜索窗口',
    )!
    search.props.onChange?.({
      target: { value: 'first' },
    } as ChangeEvent<HTMLInputElement>)
    components(page.render(), Button)
      .find((node) => node.props['aria-label'] === '编辑 first')!
      .props.onClick?.({} as never)
    expect(components(page.render(), WindowEditor)).toHaveLength(1)
    selectProvider(page.render(), 'adspower')
    expect(components(page.render(), WindowEditor)).toHaveLength(0)
    expect(components(page.render(), Checkbox).every((node) => !node.props.checked)).toBe(
      true,
    )
    expect(visibleWindowNames(page.render())).toEqual(['Ads shop'])
    selectProvider(page.render(), 'cloakbrowser')
    expect(visibleWindowNames(page.render())).toEqual(['first'])
  })

  it('does not start or stop an unknown external window when checking its state', async () => {
    state.realLaunch = true
    const page = await externalPage()
    state.windows = state.windows.map((window) =>
      window.id === 'ads-shop' ? { ...window, state: 'unknown' as const } : window,
    )
    selectProvider(page.render(), 'adspower')
    components(page.render(), Button)
      .find((node) => Children.toArray(node.props.children).includes('刷新'))!
      .props.onClick?.({} as never)
    await vi.waitFor(() =>
      expect(windowStatus(page.render(), 'Ads shop')).toBe('状态待确认'),
    )
    windowAction(page.render(), 'Ads shop', '确认状态').props.onClick?.({} as never)
    await vi.waitFor(() =>
      expect(components(page.render(), ProxyGateDialog)[0]?.props.stage.stage).toBe(
        'unconfirmed',
      ),
    )
    expect(startBrowserWindow).not.toHaveBeenCalled()
    expect(stopBrowserWindow).not.toHaveBeenCalled()
  })

  it('does not revive an old proxy dialog or launch after switching Tabs during a check', async () => {
    state.realLaunch = true
    const page = await externalPage()
    state.windows[0] = {
      ...state.windows[0]!,
      proxy: 'http://proxy.test:8080',
      proxyMode: 'manual',
    }
    components(page.render(), Button)
      .find((node) => Children.toArray(node.props.children).includes('刷新'))!
      .props.onClick?.({} as never)
    await vi.waitFor(() =>
      expect(
        components(page.render(), Sim8ExpiryNotice)[0]!.props.windows[0]!.proxy,
      ).not.toBeNull(),
    )
    const check = deferred<ProxyCheckOutcome>()
    vi.mocked(checkWindowProxy).mockReturnValueOnce(check.promise)
    windowAction(page.render(), 'first', '打开').props.onClick?.({} as never)
    selectProvider(page.render(), 'adspower')
    page.render()
    check.resolve(checkedProxy())
    await Promise.resolve()
    await Promise.resolve()
    expect(components(page.render(), ProxyGateDialog)).toHaveLength(0)
    expect(startBrowserWindow).not.toHaveBeenCalled()
  })

  it('does not launch after the connection revision changes during a proxy check', async () => {
    state.realLaunch = true
    state.windows[0] = {
      ...state.windows[0]!,
      proxyMode: 'manual',
      proxy: 'http://proxy.test:8080',
    }
    const page = await mountedPage()
    const check = deferred<ProxyCheckOutcome>()
    vi.mocked(checkWindowProxy).mockReturnValueOnce(check.promise)
    windowAction(page.render(), 'first', '打开').props.onClick?.({} as never)
    state.connections[0] = {
      ...state.connections[0]!,
      revision: state.connections[0]!.revision + 1,
    }
    refreshButton(page.render()).props.onClick?.({} as never)
    await vi.waitFor(() =>
      expect(Children.toArray(refreshButton(page.render()).props.children)).toContain(
        '刷新',
      ),
    )
    check.resolve(checkedProxy())
    await Promise.resolve()
    await Promise.resolve()
    page.render()
    expect(startBrowserWindow).not.toHaveBeenCalled()
    expect(components(page.render(), ProxyGateDialog)).toHaveLength(0)
  })

  it('describes an attached window proxy as provider-managed in its details', async () => {
    const page = await externalPage()
    selectProvider(page.render(), 'adspower')
    components(page.render(), Button)
      .find((node) => node.props['aria-label'] === '查看 Ads shop 详情')!
      .props.onClick?.({} as never)
    const row = elements(page.render()).find(
      (node) =>
        node.props.className === 'about-row' &&
        elements(node).some(
          (child) => child.type === 'dt' && child.props.children === '代理',
        ),
    )!
    expect(elements(row).find((node) => node.type === 'dd')?.props.children).toBe(
      '沿用浏览器设置',
    )
  })

  it('keeps the latest global snapshot when an older refresh completes later', async () => {
    const page = await externalPage()
    const old = deferred<BrowserWindow[]>()
    vi.mocked(listBrowserWindows).mockReturnValueOnce(old.promise)
    const refreshing = components(page.render(), Button).find((node) =>
      Children.toArray(node.props.children).includes('刷新'),
    )!
    refreshing.props.onClick?.({} as never)
    const load = components(page.render(), WindowEditor)
    expect(load).toHaveLength(0)
    // A completed create refreshes through the same guarded inventory reader.
    components(page.render(), Button)
      .find((node) => Children.toArray(node.props.children).includes('创建窗口'))!
      .props.onClick?.({} as never)
    const settings = browserWindow().settings
    vi.mocked(createBrowserWindow).mockImplementationOnce(async () => {
      const created = browserWindow({ id: 'created', name: 'created' })
      state.windows.push(created)
      return created
    })
    await components(page.render(), WindowEditor)[0]!.props.onSave({
      name: 'new',
      proxyMode: 'direct',
      proxy: null,
      proxyPlugin: null,
      proxyEndpoint: null,
      settings,
      groupId: null,
      kernelVersion: null,
    })
    old.resolve([profile('stale')])
    await Promise.resolve()
    await Promise.resolve()
    expect(visibleWindowNames(page.render())).not.toContain('stale')
    expect(visibleWindowNames(page.render())).toContain('created')
  })

  it('ignores a refresh failure from the previous provider Tab', async () => {
    const page = await externalPage()
    const old = deferred<BrowserWindow[]>()
    vi.mocked(listBrowserWindows).mockReturnValueOnce(old.promise)
    refreshButton(page.render()).props.onClick?.({} as never)
    selectProvider(page.render(), 'adspower')
    old.reject(new Error('Previous Tab read failed'))
    await vi.waitFor(() =>
      expect(Children.toArray(refreshButton(page.render()).props.children)).toContain(
        '刷新',
      ),
    )
    expect(
      components(page.render(), FieldError).map((node) => node.props.children),
    ).not.toContain('Previous Tab read failed')
  })
})

describe('starting window row highlighting', () => {
  it('never confirms startup using a superseded running-state response', async () => {
    state.realLaunch = true
    state.windows[0] = {
      ...state.windows[0]!,
      proxyMode: 'manual',
      proxy: 'http://proxy.example.com:8080',
    }
    const page = await mountedPage()
    const old = deferred<BrowserWindow[]>()
    const reads = vi.mocked(listBrowserWindows).mock.calls.length
    vi.mocked(listBrowserWindows).mockReturnValueOnce(old.promise)
    windowAction(page.render(), 'first', '打开').props.onClick?.({} as never)
    await vi.waitFor(() => expect(listBrowserWindows).toHaveBeenCalledTimes(reads + 1))
    refreshButton(page.render()).props.onClick?.({} as never)
    await vi.waitFor(() => expect(listBrowserWindows).toHaveBeenCalledTimes(reads + 2))
    old.resolve(
      state.windows.map((window) =>
        window.id === 'first' ? { ...window, state: 'running' as const } : window,
      ),
    )
    await vi.waitFor(() => {
      expect(components(page.render(), ProxyGateDialog)[0]?.props.stage.stage).toBe(
        'unconfirmed',
      )
    })
    expect(toast.success).not.toHaveBeenCalledWith('「first」已打开')
    expect(windowStatus(page.render(), 'first')).not.toBe('运行中')
  })

  it('keeps a timed-out stop blocked until it settles without marking it as a startup', async () => {
    vi.useFakeTimers()
    state.realLaunch = true
    const page = await mountedPage()
    const stop = deferred<void>()
    vi.mocked(stopBrowserWindow).mockReturnValueOnce(stop.promise)
    windowAction(page.render(), 'second', '停止').props.onClick?.({} as never)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(windowStatus(page.render(), 'second')).toBe('状态待确认')
    expect(windowRow(page.render(), 'second').props.className).toBeUndefined()
    windowAction(page.render(), 'second', '确认状态').props.onClick?.({} as never)
    await vi.waitFor(() =>
      expect(components(page.render(), ProxyGateDialog)[0]?.props.stage.stage).toBe(
        'unconfirmed',
      ),
    )
    expect(stopBrowserWindow).toHaveBeenCalledExactlyOnceWith('second')
    state.windows = state.windows.map((window) =>
      window.id === 'second' ? { ...window, state: 'stopped' as const } : window,
    )
    stop.resolve()
    await vi.waitFor(() => expect(windowStatus(page.render(), 'second')).toBe('已停止'))
  })

  it('highlights a pending launch, never a simultaneous stop, and clears after confirmed startup', async () => {
    state.realLaunch = true
    const page = await mountedPage()
    const start = deferred<void>()
    const stop = deferred<void>()
    vi.mocked(startBrowserWindow).mockReturnValue(start.promise)
    vi.mocked(stopBrowserWindow).mockReturnValue(stop.promise)
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
      window.id === 'first' ? { ...window, state: 'running' as const } : window,
    )
    start.resolve()
    await vi.waitFor(() => expect(windowStatus(page.render(), 'first')).toBe('运行中'))
    expect(windowRow(page.render(), 'first').props.className).toBeUndefined()
    expect(windowRow(page.render(), 'first').props['aria-busy']).toBeUndefined()
    state.windows = state.windows.map((window) =>
      window.id === 'second' ? { ...window, state: 'stopped' as const } : window,
    )
    stop.resolve()
    await vi.waitFor(() => expect(windowStatus(page.render(), 'second')).toBe('已停止'))
    expect(windowRow(page.render(), 'second').props.className).toBeUndefined()
    expect(startBrowserWindow).toHaveBeenCalledExactlyOnceWith('first')
    expect(stopBrowserWindow).toHaveBeenCalledExactlyOnceWith('second')
  })

  it('clears the highlight after a definite launch rejection', async () => {
    state.realLaunch = true
    const page = await mountedPage()
    const start = deferred<void>()
    vi.mocked(startBrowserWindow).mockReturnValue(start.promise)
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
    expect(startBrowserWindow).not.toHaveBeenCalled()
    check.resolve({ kind: 'unsupported', reason: '代理池暂不可用' })
    await vi.waitFor(() => {
      expect(components(page.render(), ProxyGateDialog)[0]!.props.stage.stage).toBe(
        'blocked',
      )
    })
    expect(windowRow(page.render(), 'first').props.className).toBeUndefined()
    expect(windowStatus(page.render(), 'first')).toBe('已停止')
    expect(startBrowserWindow).not.toHaveBeenCalled()
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
    vi.mocked(startBrowserWindow).mockReturnValue(start.promise)
    windowAction(page.render(), 'first', '打开').props.onClick?.({} as never)
    expect(windowStatus(page.render(), 'first')).toBe('检测代理中')
    check.resolve(checkedProxy())
    await vi.waitFor(() => expect(windowStatus(page.render(), 'first')).toBe('启动中'))
    expect(windowRow(page.render(), 'first').props.className).toBe('space-row-starting')
    expect(components(page.render(), ProxyGateDialog)[0]!.props.stage.stage).toBe(
      'launching',
    )
    state.windows = state.windows.map((window) =>
      window.id === 'first' ? { ...window, state: 'running' as const } : window,
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
    vi.mocked(startBrowserWindow).mockReturnValue(start.promise)
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
    expect(startBrowserWindow).toHaveBeenCalledTimes(1)

    const confirmation = deferred<BrowserWindow[]>()
    state.profileReadResponse = confirmation.promise
    const reads = vi.mocked(listBrowserWindows).mock.calls.length
    start.resolve()
    await vi.waitFor(() => expect(listBrowserWindows).toHaveBeenCalledTimes(reads + 1))
    expect(windowRow(page.render(), 'first').props.className).toBe('space-row-starting')
    confirmation.resolve(
      state.windows.map((window) =>
        window.id === 'first' ? { ...window, state: 'running' as const } : window,
      ),
    )
    await vi.waitFor(() => expect(windowStatus(page.render(), 'first')).toBe('运行中'))
    expect(windowRow(page.render(), 'first').props.className).toBeUndefined()
    expect(components(page.render(), ProxyGateDialog)).toHaveLength(0)
  })

  it('keeps failed startup confirmation highlighted until a subsequent read confirms the settled window is stopped', async () => {
    state.realLaunch = true
    const page = await mountedPage()
    const confirmation = deferred<BrowserWindow[]>()
    state.profileReadResponse = confirmation.promise
    const reads = vi.mocked(listBrowserWindows).mock.calls.length
    windowAction(page.render(), 'first', '打开').props.onClick?.({} as never)
    await vi.waitFor(() => expect(listBrowserWindows).toHaveBeenCalledTimes(reads + 1))
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
    expect(startBrowserWindow).toHaveBeenCalledTimes(1)
  })
})

describe('window account status filtering', () => {
  it('offers grouped status options and combines account, group and search filters in newest order', async () => {
    state.accounts[0] = account({ status: 'blocked' })
    state.groups = [{ id: 'work', name: '工作组', note: '', windowCount: 4 }]
    state.windows = [
      { ...profile('first'), createdAt: 100, groupId: 'work' },
      { ...profile('second', 'running'), createdAt: 300, groupId: 'work' },
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
