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
import { Button } from '@/components/ui/button'
import { DialogContent } from '@/components/ui/dialog'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { toast } from '@/components/ui/toast'
import { AccountEditor } from '@/features/accounts/account-editor'
import type { Account, AccountInput, BindingView } from '@/features/accounts/types'
import {
  createNativeProfile,
  updateNativeProfile,
  type NativeProfile,
} from '@/lib/platform/native-profiles'
import type { PluginView } from '@/lib/platform/native-plugins'
import { AccountPhoneCopy, AccountSmsPopover } from './account-sms-popover'
import { SpacesPage } from './spaces-page'
import { WindowEditor } from './window-editor'

const state = vi.hoisted(() => ({
  hooks: null as HookHarness | null,
  native: false,
  plugin: null as PluginView | null,
  accounts: [] as Account[],
  bindings: [] as BindingView[],
  windows: [] as NativeProfile[],
  calls: [] as { method: string; input: unknown }[],
  saved: null as Account | null,
  listError: null as Error | null,
  saveError: null as Error | null,
  saveResponse: null as Promise<{ item: Account; created: boolean }> | null,
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
    ) => (state.hooks ? callback : realCallback(callback, deps)),
  }
})

vi.mock('@/lib/platform/native-plugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-plugins')>()),
  listPlugins: async () => (state.plugin ? [state.plugin] : []),
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
      return {
        items: state.accounts,
        bindings: state.bindings,
        total: state.accounts.length,
        storageDurable: true,
      }
    }
    if (method === 'vinted.accounts.bindings') return { items: state.bindings }
    if (method === 'vinted.accounts.save') {
      if (state.saveError) throw state.saveError
      return state.saveResponse ?? { item: state.saved, created: false }
    }
    throw new Error(`Unexpected account method: ${method}`)
  },
}))

vi.mock('@/lib/platform/native-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-profiles')>()),
  nativeProfilesAvailable: () => state.native,
  listNativeProfiles: async () => state.windows,
  createNativeProfile: vi.fn(async () => ({
    ...state.windows[0]!,
    id: 'created',
    name: 'created',
  })),
  updateNativeProfile: vi.fn(async () => undefined),
}))
vi.mock('@/lib/platform/native-groups', () => ({ listGroups: async () => [] }))
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
vi.mock('./use-window-launch', () => ({
  useWindowLaunch: () => ({
    gate: null,
    operatingWindows: new Set(),
    unconfirmedWindows: new Set(),
  }),
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
  state.listError = null
  state.saveError = null
  state.saveResponse = null
  state.calls = []
})

afterEach(() => {
  for (const instance of harnesses.splice(0)) instance.dispose()
})

async function mountedPage() {
  state.native = true
  const page = harness()
  const render = () => {
    const tree = page.render(SpacesPage)
    page.flushEffects()
    return tree
  }
  await vi.waitFor(() => {
    const tree = render()
    const loaded = components(tree, Button).some((node) =>
      node.props['aria-label']?.startsWith('查看 first'),
    )
    expect(loaded).toBe(true)
    if (state.plugin?.state === 'running') {
      expect(components(tree, AccountSmsPopover)).toHaveLength(3)
    }
  })
  return { render }
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
      elements(page.render()).filter(
        (node) => node.type === 'small' && node.props.children === '待验证',
      ),
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
    const summaries = elements(tree).filter(
      (node) => node.type === 'small' && node.props.children === '封禁',
    )
    expect(summaries).toHaveLength(2)
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
      elements(tree).filter(
        (node) => node.type === 'small' && node.props.children === '待验证',
      ),
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
