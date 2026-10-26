import {
  createElement,
  type ChangeEvent,
  type DependencyList,
  type EffectCallback,
  type MouseEvent,
  type ReactElement,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlertDialog, AlertDialogAction } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { toast } from '@/components/ui/toast'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness as HookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { updateContact } from '@/features/sim8/accounts-bridge'
import { BatchWindowDialog } from '@/features/spaces/batch-window-dialog'
import type { PluginView } from '@/lib/platform/native-plugins'
import { AccountEditor } from './account-editor'
import { listAccounts, readOtp, removeAccount, saveAccount } from './api'
import { AccountsPage } from './accounts-page'
import {
  ACCOUNT_STATUSES,
  EMPTY_ACCOUNT,
  LOGIN_METHODS,
  type Account,
  type AccountList,
  type OtpResult,
} from './types'

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
    ) => (state.hooks ? callback : react.useCallback(callback, deps)),
  }
})
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  listAccounts: vi.fn(),
  readOtp: vi.fn(),
  removeAccount: vi.fn(),
  saveAccount: vi.fn(),
}))
vi.mock('@/features/sim8/accounts-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/sim8/accounts-bridge')>()),
  updateContact: vi.fn(),
}))
vi.mock('@/lib/platform/native-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-profiles')>()),
  nativeProfilesAvailable: () => true,
}))
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

function plugin(overrides: Partial<PluginView> = {}): PluginView {
  const base: PluginView = {
    id: 'studio.vinted-accounts',
    name: 'Vinted 账号池',
    version: '1.0.0',
    apiVersion: 1,
    minCoreVersion: '0.1.0',
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
  return { ...base, ...overrides }
}

function render(overrides: Partial<Parameters<typeof AccountsPage>[0]>): string {
  return renderToStaticMarkup(
    createElement(AccountsPage, {
      plugin: null,
      hostAvailable: true,
      ...overrides,
    }),
  )
}

describe('vinted accounts page', () => {
  it('says the page needs the desktop host', () => {
    const html = render({ hostAvailable: false })
    expect(html).toContain('Vinted 账号需要桌面应用')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('aria-label="账号列表"')
  })

  it('does not allow editing with a stale running plugin but no desktop host', () => {
    const html = render({ hostAvailable: false, plugin: plugin() })
    expect(html).toContain('Vinted 账号需要桌面应用')
    expect(html).not.toContain('aria-label="账号列表"')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?新增账号<\/button>/s)
  })

  it('points to the plugin center when the plugin is missing', () => {
    expect(render({ plugin: null })).toContain('Vinted 账号插件尚未安装')
  })

  it('waits for a starting process instead of offering a restart', () => {
    const html = render({ plugin: plugin({ state: 'starting' }) })
    expect(html).toContain('Vinted 账号插件正在启动')
    expect(html).not.toContain('重新启动插件进程')
    expect(html).not.toContain('aria-label="账号列表"')
  })

  it('shows the empty pool with the import and add actions', () => {
    const html = render({ plugin: plugin() })
    expect(html).toContain('aria-label="账号列表"')
    expect(html).toContain('还没有账号')
    expect(html).toContain('新增账号')
    expect(html).toContain('导入')
    expect(html).toContain('全选当前页账号')
    const buttons =
      html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g) ?? []
    expect(buttons.find((button) => button.endsWith('批量创建窗口</button>'))).toMatch(
      /\bdisabled=""/,
    )
    // No explanatory paragraph: the page is a table, not a tour.
    expect(html).not.toContain('page-description')
    expect(html).not.toContain('演示占位')
  })
})

function account(index: number, overrides: Partial<Account> = {}): Account {
  return {
    ...EMPTY_ACCOUNT,
    id: `account-${index}`,
    account: `seller-${String(index).padStart(2, '0')}`,
    password: '  synthetic password  ',
    status: ACCOUNT_STATUSES[index % ACCOUNT_STATUSES.length]!,
    loginMethod: LOGIN_METHODS[index % LOGIN_METHODS.length]!,
    phone: index % 2 === 0 ? `+1415555${String(index).padStart(4, '0')}` : '',
    emailOtpUrl: 'https://example.com/mail',
    smsOtpUrl: index % 2 === 0 ? 'https://example.com/sms' : '',
    createdAt: new Date(Date.UTC(2026, 9, 26, 10, 0, index)).toISOString(),
    updatedAt: '2026-10-26T12:00:00Z',
    ...overrides,
  }
}

function inventory(
  items = Array.from({ length: 55 }, (_, index) => account(index)),
): AccountList {
  return {
    items,
    total: items.length,
    bindings: items
      .filter((_, index) => index % 3 === 0)
      .map((item) => ({
        accountId: item.id,
        windowId: `window-${item.id}`,
        boundAt: '2026-10-26T12:00:00Z',
      })),
    storageDurable: true,
  }
}

function otp(channel: OtpResult['channel'], code = '123456'): OtpResult {
  return {
    channel,
    code,
    body: `code: ${code}`,
    contentType: 'text/plain',
    truncated: false,
    fetchedAt: '2026-10-26T12:00:00Z',
  }
}

let hooks: HookHarness
let props: Parameters<typeof AccountsPage>[0]
const tree = () => hooks.render(() => AccountsPage(props))
const button = (label: string) =>
  components(tree(), Button).find(
    (node) => node.props['aria-label'] === label || text(node.props.children) === label,
  )!
const click = (label: string) =>
  button(label).props.onClick?.({} as MouseEvent<HTMLButtonElement>)
const select = (label: string, value: string) =>
  components(tree(), LabeledSelect)
    .find((node) => node.props.ariaLabel === label)!
    .props.onValueChange(value)
const selectedCount = () =>
  elements(tree()).find(
    (node) =>
      node.type === 'span' && text(node.props.children as string).startsWith('已选 '),
  )!.props.children
const header = () =>
  components(tree(), Checkbox).find(
    (node) => node.props['aria-label'] === '全选当前页账号',
  )!
const rowCheckboxes = () =>
  components(tree(), Checkbox).filter((node) =>
    node.props['aria-label']?.startsWith('选择账号 '),
  )
const search = (value: string) =>
  components(tree(), Input)
    .find((node) => node.props['aria-label'] === '搜索账号')!
    .props.onChange?.({ target: { value } } as ChangeEvent<HTMLInputElement>)

interface OtpCellProps extends Record<string, unknown> {
  account: Account
  state: OtpResult | null
  busy: string | null
  smsDisabled: boolean
  onFetch: (channel: 'email' | 'sms') => void
}
function otpCell(id: string): ReactElement<OtpCellProps> {
  return elements(tree()).find(
    (node) =>
      typeof node.type === 'function' &&
      node.type.name === 'OtpCell' &&
      (node.props.account as Account).id === id,
  ) as ReactElement<OtpCellProps>
}
function otpDialogs() {
  return elements(tree()).filter(
    (node) => typeof node.type === 'function' && node.type.name === 'OtpDialog',
  )
}
async function mount(data = inventory()) {
  vi.mocked(listAccounts).mockResolvedValue(data)
  tree()
  hooks.flushEffects()
  await flushPromises()
}

beforeEach(() => {
  vi.resetAllMocks()
  hooks = new HookHarness(state)
  props = { plugin: plugin(), hostAvailable: true }
  vi.mocked(listAccounts).mockResolvedValue(inventory([]))
})
afterEach(() => hooks.dispose())

describe('account table controls', () => {
  it('shows 20 newest records, navigates all 55 and resets when page size changes', async () => {
    await mount()
    expect(rowCheckboxes()).toHaveLength(20)
    expect(rowCheckboxes()[0]!.props['aria-label']).toBe('选择账号 seller-54')
    expect(text(tree())).toContain('第 1 / 3 页')
    expect(button('上一页').props.disabled).toBe(true)
    click('下一页')
    expect(rowCheckboxes()[0]!.props['aria-label']).toBe('选择账号 seller-34')
    select('每页账号数', '50')
    expect(rowCheckboxes()).toHaveLength(50)
    expect(text(tree())).toContain('第 1 / 2 页')
    click('下一页')
    expect(rowCheckboxes()).toHaveLength(5)
    expect(button('下一页').props.disabled).toBe(true)
    select('每页账号数', '100')
    expect(rowCheckboxes()).toHaveLength(55)
    expect(text(tree())).toContain('第 1 / 1 页')
    expect(listAccounts).toHaveBeenCalledTimes(1)
  })

  it('selects only the current page and preserves selection across pages and filters for batching', async () => {
    await mount()
    header().props.onCheckedChange?.(true)
    expect(text(selectedCount() as string)).toBe('已选 20')
    click('下一页')
    expect(header().props.checked).toBe(false)
    rowCheckboxes()[0]!.props.onCheckedChange?.(true)
    expect(header().props.checked).toBe('indeterminate')
    search('seller-00')
    expect(text(tree())).toContain('第 1 / 1 页')
    expect(text(selectedCount() as string)).toBe('已选 21')
    expect(header().props.checked).toBe(false)
    header().props.onCheckedChange?.(true)
    expect(text(selectedCount() as string)).toBe('已选 22')
    header().props.onCheckedChange?.(false)
    expect(text(selectedCount() as string)).toBe('已选 21')
    select('筛选账号状态', 'blocked')
    expect(rowCheckboxes()).toHaveLength(0)
    expect(text(selectedCount() as string)).toBe('已选 21')
    click('批量创建窗口')
    const batch = components(tree(), BatchWindowDialog)[0]!
    expect(batch.props.accounts).toHaveLength(21)
    expect(new Set(batch.props.accounts!.map((item) => item.id))).toEqual(
      new Set(Array.from({ length: 21 }, (_, index) => `account-${index + 34}`)),
    )
    batch.props.onClose()
    click('清空选择')
    expect(text(selectedCount() as string)).toBe('已选 0')
  })

  it('combines every filter, resets to page one and keeps all filter options available', async () => {
    await mount()
    click('下一页')
    search('seller')
    expect(text(tree())).toContain('第 1 / 3 页')
    select('筛选账号状态', 'active')
    select('筛选登录方式', 'email')
    select('筛选手机号', 'with')
    select('筛选窗口关联', 'bound')
    expect(rowCheckboxes().map((node) => node.props['aria-label'])).toEqual(
      [48, 36, 24, 12, 0].map(
        (index) => `选择账号 seller-${String(index).padStart(2, '0')}`,
      ),
    )
    expect(
      components(tree(), LabeledSelect).find(
        (node) => node.props.ariaLabel === '筛选账号状态',
      )!.props.options,
    ).toHaveLength(5)
    expect(
      components(tree(), LabeledSelect).find(
        (node) => node.props.ariaLabel === '筛选登录方式',
      )!.props.options,
    ).toHaveLength(5)
    click('重置筛选')
    expect(rowCheckboxes()).toHaveLength(20)
    expect(text(tree())).toContain('第 1 / 3 页')
    expect(
      components(tree(), LabeledSelect)
        .filter((node) => node.props.ariaLabel.startsWith('筛选'))
        .every((node) => node.props.value === 'all'),
    ).toBe(true)
  })

  it('clamps after refresh, prunes deleted selections and stays clamped if inventory grows again', async () => {
    await mount()
    header().props.onCheckedChange?.(true)
    click('下一页')
    click('下一页')
    const small = inventory(Array.from({ length: 5 }, (_, index) => account(index + 34)))
    vi.mocked(listAccounts).mockResolvedValueOnce(small)
    click('刷新')
    await flushPromises()
    expect(text(tree())).toContain('第 1 / 1 页')
    expect(text(selectedCount() as string)).toBe('已选 4')
    vi.mocked(listAccounts).mockResolvedValueOnce(inventory())
    click('刷新')
    await flushPromises()
    expect(text(tree())).toContain('第 1 / 3 页')
    expect(text(selectedCount() as string)).toBe('已选 4')
  })

  it('clamps after deleting the last record on a page', async () => {
    const data = inventory(Array.from({ length: 21 }, (_, index) => account(index)))
    await mount(data)
    click('下一页')
    click('删除 seller-00')
    vi.mocked(removeAccount).mockResolvedValueOnce({ removed: true })
    vi.mocked(listAccounts).mockResolvedValueOnce(inventory(data.items.slice(1)))
    components(tree(), AlertDialogAction)[0]!.props.onClick?.({
      preventDefault: () => {},
    } as MouseEvent<HTMLButtonElement>)
    await flushPromises()
    expect(text(tree())).toContain('第 1 / 1 页')
    expect(rowCheckboxes()).toHaveLength(20)
    expect(removeAccount).toHaveBeenCalledExactlyOnceWith('account-0')
  })

  it('enforces the 100-account batch limit across pages', async () => {
    await mount(inventory(Array.from({ length: 101 }, (_, index) => account(index))))
    select('每页账号数', '100')
    header().props.onCheckedChange?.(true)
    click('下一页')
    header().props.onCheckedChange?.(true)
    click('批量创建窗口')
    expect(toast.error).toHaveBeenCalledWith('每批最多选择 100 个账号。')
    expect(components(tree(), BatchWindowDialog)).toHaveLength(0)
    expect(text(selectedCount() as string)).toBe('已选 101')
  })

  it('marks blocked names and badges with semantic destructive styling and shows creation time', async () => {
    await mount(inventory([account(3, { createdAt: '2099-01-01T12:34:56Z' })]))
    const name = elements(tree()).find(
      (node) => node.type === 'strong' && node.props.children === 'seller-03',
    )!
    expect(name.props.className).toContain('text-destructive')
    expect(
      components(tree(), Badge).find((node) => node.props.children === '封禁')!.props
        .variant,
    ).toBe('destructive')
    expect(text(tree())).toContain('创建时间')
    expect(text(tree())).toMatch(/2099-01-\d{2} \d{2}:\d{2}:56/)
  })
})

describe('unlinking account phone numbers', () => {
  it('merges the latest saved account, keeps bindings, and clears only SMS results', async () => {
    const original = account(0)
    const data = inventory([original])
    data.bindings.push({ accountId: original.id, windowId: 'second-window', boundAt: '' })
    await mount(data)
    vi.mocked(readOtp).mockResolvedValueOnce(otp('sms'))
    otpCell(original.id).props.onFetch('sms')
    await flushPromises()
    expect(otpCell(original.id).props.state?.code).toBe('123456')
    expect(otpDialogs()).toHaveLength(1)
    const saved = {
      ...original,
      phone: '',
      smsOtpUrl: '',
      note: 'latest note',
      password: '  latest secret  ',
    }
    vi.mocked(updateContact).mockResolvedValueOnce(saved)
    click('解绑 seller-00 的手机号')
    await flushPromises()
    expect(updateContact).toHaveBeenCalledExactlyOnceWith(original.id, {
      phone: '',
      smsOtpUrl: '',
    })
    expect(otpCell(original.id).props.account).toEqual(saved)
    expect(otpCell(original.id).props.state).toBeNull()
    expect(otpDialogs()).toHaveLength(0)
    expect(text(tree())).toContain('2 个窗口')
    expect(text(tree())).toContain('latest note')
    expect(
      components(tree(), Button).some(
        (node) => node.props['aria-label'] === '解绑 seller-00 的手机号',
      ),
    ).toBe(false)
    expect(components(tree(), AlertDialog)[0]!.props.open).toBe(false)
    expect(saveAccount).not.toHaveBeenCalled()
    expect(removeAccount).not.toHaveBeenCalled()
    expect(listAccounts).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('手机号与短信接码链接已解绑')
  })

  it('blocks duplicate unlink, row edit/delete and SMS during a pending write, retaining data on failure for retry', async () => {
    const original = account(0)
    await mount(inventory([original]))
    const pending = deferred<Account>()
    vi.mocked(updateContact).mockReturnValueOnce(pending.promise)
    const unlink = button('解绑 seller-00 的手机号').props.onClick!
    const edit = button('编辑 seller-00').props.onClick!
    const remove = button('删除 seller-00').props.onClick!
    unlink({} as MouseEvent<HTMLButtonElement>)
    unlink({} as MouseEvent<HTMLButtonElement>)
    edit({} as MouseEvent<HTMLButtonElement>)
    remove({} as MouseEvent<HTMLButtonElement>)
    otpCell(original.id).props.onFetch('sms')
    expect(updateContact).toHaveBeenCalledTimes(1)
    expect(readOtp).not.toHaveBeenCalled()
    expect(button('解绑 seller-00 的手机号').props.disabled).toBe(true)
    expect(button('编辑 seller-00').props.disabled).toBe(true)
    expect(button('删除 seller-00').props.disabled).toBe(true)
    expect(otpCell(original.id).props.smsDisabled).toBe(true)
    expect(components(tree(), AccountEditor)).toHaveLength(0)
    expect(components(tree(), AlertDialog)[0]!.props.open).toBe(false)
    pending.reject(new Error('storage failed'))
    await flushPromises()
    expect(otpCell(original.id).props.account).toEqual(original)
    expect(button('解绑 seller-00 的手机号').props.disabled).toBe(false)
    expect(toast.error).toHaveBeenCalledWith('解绑手机号失败：storage failed')
    expect(toast.success).not.toHaveBeenCalled()
    vi.mocked(updateContact).mockResolvedValueOnce({
      ...original,
      phone: '',
      smsOtpUrl: '',
    })
    click('解绑 seller-00 的手机号')
    await flushPromises()
    expect(updateContact).toHaveBeenCalledTimes(2)
    expect(otpCell(original.id).props.account.phone).toBe('')
  })

  it.each(['success', 'failure'])(
    'discards a late SMS %s without disturbing a newer email request',
    async (outcome) => {
      const original = account(0)
      await mount(inventory([original]))
      const sms = deferred<OtpResult>()
      const email = deferred<OtpResult>()
      vi.mocked(readOtp)
        .mockReturnValueOnce(sms.promise)
        .mockReturnValueOnce(email.promise)
      otpCell(original.id).props.onFetch('sms')
      vi.mocked(updateContact).mockResolvedValueOnce({
        ...original,
        phone: '',
        smsOtpUrl: '',
      })
      click('解绑 seller-00 的手机号')
      await flushPromises()
      otpCell(original.id).props.onFetch('email')
      if (outcome === 'success') sms.resolve(otp('sms', '999999'))
      else sms.reject(new Error('late SMS error'))
      await flushPromises()
      expect(otpCell(original.id).props.busy).toBe(`${original.id}:email`)
      expect(otpCell(original.id).props.state).toBeNull()
      expect(otpDialogs()).toHaveLength(0)
      expect(toast.error).not.toHaveBeenCalled()
      email.resolve(otp('email', '654321'))
      await flushPromises()
      expect(otpCell(original.id).props.state?.code).toBe('654321')
      expect(otpCell(original.id).props.state?.channel).toBe('email')
      expect(otpDialogs()).toHaveLength(1)
    },
  )

  it('preserves a cached email code and its dialog when unlinking the phone', async () => {
    const original = account(0)
    await mount(inventory([original]))
    vi.mocked(readOtp).mockResolvedValueOnce(otp('email', '654321'))
    otpCell(original.id).props.onFetch('email')
    await flushPromises()
    vi.mocked(updateContact).mockResolvedValueOnce({
      ...original,
      phone: '',
      smsOtpUrl: '',
    })
    click('解绑 seller-00 的手机号')
    await flushPromises()
    expect(otpCell(original.id).props.state?.code).toBe('654321')
    expect(otpDialogs()).toHaveLength(1)
    expect(otpDialogs()[0]!.props.result).toMatchObject({ channel: 'email' })
  })

  it('does not let an older refresh restore the phone after a successful unlink', async () => {
    const original = account(0)
    const data = inventory([original])
    await mount(data)
    const stale = deferred<AccountList>()
    vi.mocked(listAccounts).mockReturnValueOnce(stale.promise)
    click('刷新')
    vi.mocked(updateContact).mockResolvedValueOnce({
      ...original,
      phone: '',
      smsOtpUrl: '',
    })
    click('解绑 seller-00 的手机号')
    await flushPromises()
    stale.resolve(data)
    await flushPromises()
    expect(otpCell(original.id).props.account.phone).toBe('')
    expect(otpCell(original.id).props.account.smsOtpUrl).toBe('')
  })

  it.each(['success', 'failure'])(
    'keeps an unrelated deletion reload when phone unlink ends in %s',
    async (outcome) => {
      const kept = account(0)
      const removed = account(2)
      const data = inventory([kept, removed])
      data.bindings.push({
        accountId: removed.id,
        windowId: 'removed-window',
        boundAt: '',
      })
      await mount(data)
      header().props.onCheckedChange?.(true)
      const reload = deferred<AccountList>()
      vi.mocked(removeAccount).mockResolvedValueOnce({ removed: true })
      vi.mocked(listAccounts).mockReturnValueOnce(reload.promise)
      click('删除 seller-02')
      components(tree(), AlertDialogAction)[0]!.props.onClick?.({
        preventDefault: () => {},
      } as MouseEvent<HTMLButtonElement>)
      await flushPromises()
      expect(listAccounts).toHaveBeenCalledTimes(2)

      if (outcome === 'success') {
        vi.mocked(updateContact).mockResolvedValueOnce({
          ...kept,
          phone: '',
          smsOtpUrl: '',
          note: 'latest contact record',
        })
      } else {
        vi.mocked(updateContact).mockRejectedValueOnce(new Error('unlink failed'))
      }
      click('解绑 seller-00 的手机号')
      await flushPromises()
      reload.resolve(inventory([kept]))
      await flushPromises()

      expect(rowCheckboxes().map((node) => node.props['aria-label'])).toEqual([
        '选择账号 seller-00',
      ])
      expect(text(selectedCount() as string)).toBe('已选 1')
      expect(text(tree())).toContain('共 1 个账号 · 第 1 / 1 页')
      expect(text(tree())).toContain('1 个窗口已关联')
      expect(otpCell(kept.id).props.account.phone).toBe(
        outcome === 'success' ? '' : kept.phone,
      )
      expect(otpCell(kept.id).props.account.smsOtpUrl).toBe(
        outcome === 'success' ? '' : kept.smsOtpUrl,
      )
      if (outcome === 'success') expect(text(tree())).toContain('latest contact record')
      expect(listAccounts).toHaveBeenCalledTimes(2)
      expect(toast.success).toHaveBeenCalledWith('账号已删除')
    },
  )

  it('accepts the latest complete list with concurrent contact changes without recursive reads or permanent overlays', async () => {
    const kept = account(0)
    const removed = account(2)
    const data = inventory([kept, removed])
    await mount(data)
    const older = deferred<AccountList>()
    const newer = deferred<AccountList>()
    vi.mocked(listAccounts)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    click('刷新')
    vi.mocked(removeAccount).mockResolvedValueOnce({ removed: true })
    click('删除 seller-02')
    components(tree(), AlertDialogAction)[0]!.props.onClick?.({
      preventDefault: () => {},
    } as MouseEvent<HTMLButtonElement>)
    await flushPromises()
    vi.mocked(updateContact).mockResolvedValueOnce({
      ...kept,
      phone: '',
      smsOtpUrl: '',
    })
    click('解绑 seller-00 的手机号')
    await flushPromises()

    newer.resolve(inventory([kept]))
    await flushPromises()
    older.resolve(data)
    await flushPromises()
    expect(rowCheckboxes()).toHaveLength(1)
    expect(otpCell(kept.id).props.account.phone).toBe('')
    expect(listAccounts).toHaveBeenCalledTimes(3)

    const externallyUpdated = { ...kept, phone: '+14155550999', note: 'new server data' }
    vi.mocked(listAccounts).mockResolvedValueOnce(inventory([externallyUpdated]))
    click('刷新')
    await flushPromises()
    expect(otpCell(kept.id).props.account).toEqual(externallyUpdated)
    expect(listAccounts).toHaveBeenCalledTimes(4)
  })
})
