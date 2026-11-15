import {
  type ChangeEvent,
  type DependencyList,
  type EffectCallback,
  type FormEvent,
  type MouseEvent,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover } from '@/components/ui/popover'
import { Tabs } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toast'
import type { Account } from '@/features/accounts/types'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { NumberPoolList } from '@/features/sim8/number-picker'
import { AccountSmsPopover } from './account-sms-popover'

const state = vi.hoisted(() => ({
  hooks: null as KernelHookHarness | null,
  latest: null as Account | null,
  saved: null as Account | null,
  saveError: null as Error | null,
  saveResponse: null as Promise<{ item: Account; created: boolean }> | null,
  calls: [] as { method: string; input: unknown }[],
}))

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
    useId: () =>
      state.hooks ? state.hooks.state('test-sms-url')[0] : react.useId(),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : react.useEffect(effect, deps),
  }
})
vi.mock('@/lib/platform/native-plugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/native-plugins')>()),
  callPlugin: async (
    _plugin: string,
    _capability: string,
    method: string,
    input: unknown,
  ) => {
    state.calls.push({ method, input })
    if (method === 'vinted.accounts.list') {
      const { page, pageSize } = input as { page: number; pageSize: number }
      return {
        items: state.latest ? [state.latest] : [],
        bindings: [],
        total: state.latest ? 1 : 0,
        page,
        pageSize,
        revision: 'a'.repeat(64),
        storageDurable: true,
      }
    }
    if (method === 'vinted.accounts.save') {
      if (state.saveError) throw state.saveError
      return state.saveResponse ?? { item: state.saved, created: false }
    }
    if (method === 'vinted.accounts.otp') throw new Error('Unexpected OTP request')
    throw new Error(`Unexpected method: ${method}`)
  },
}))
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'account-1',
    account: 'synthetic@example.test',
    loginMethod: 'email',
    password: 'synthetic password',
    status: 'active',
    phone: '+14155550100',
    smsOtpUrl: 'https://sms.example.test/original?token=synthetic',
    emailOtpUrl: '',
    homepageUrl: '',
    note: '',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    ...overrides,
  }
}

let hooks: KernelHookHarness
let props: Parameters<typeof AccountSmsPopover>[0]
function tree() {
  const result = hooks.render(() => AccountSmsPopover(props))
  hooks.flushEffects()
  return result
}
const confirmation = () => components(tree(), AlertDialog).find((node) => node.props.open)
const writes = () => state.calls.filter((call) => call.method === 'vinted.accounts.save')
const confirm = () => {
  expect(confirmation()).toBeDefined()
  components(confirmation()!, AlertDialogAction)[0]!.props.onClick?.({
    preventDefault() {},
  } as MouseEvent<HTMLButtonElement>)
}
function editLink(value: string) {
  components(tree(), Tabs)[0]!.props.onValueChange?.('link')
  components(tree(), Input)[0]!.props.onChange?.({
    target: { value },
  } as ChangeEvent<HTMLInputElement>)
}
function submitLink() {
  const form = elements(tree()).find((node) => node.type === 'form')!
  ;(form.props.onSubmit as (event: FormEvent) => void)({
    preventDefault() {},
  } as FormEvent)
}
function pickNumber(tel = '+442079460000', api = 'https://new.example.test/secret') {
  components(tree(), Tabs)[0]!.props.onValueChange?.('pool')
  components(tree(), NumberPoolList)[0]!.props.onPick({ tel, api })
}

beforeEach(() => {
  vi.clearAllMocks()
  hooks = new KernelHookHarness(state)
  props = { account: account(), ready: true, onSaved: vi.fn() }
  state.latest = props.account
  state.saved = account({ smsOtpUrl: 'https://new.example.test/secret' })
  state.saveError = null
  state.saveResponse = null
  state.calls = []
})
afterEach(() => hooks.dispose())

describe('window SMS contact confirmations', () => {
  it('confirms replacing an existing link without exposing its URL and retains the draft on cancel', () => {
    components(tree(), Popover)[0]!.props.onOpenChange?.(true)
    editLink('https://new.example.test/secret')
    submitLink()
    expect(state.calls).toEqual([])
    expect(confirmation()).toBeDefined()
    const description = text(components(confirmation()!, AlertDialogDescription)[0]!)
    expect(description).toContain('高风险')
    expect(description).toContain('synthetic@example.test')
    expect(description).toContain('短信接码链接')
    expect(description).toContain('所有关联窗口')
    expect(description).not.toContain(props.account.smsOtpUrl)
    expect(description).not.toContain('https://new.example.test/secret')
    expect(description).not.toContain(props.account.password)
    confirmation()!.props.onOpenChange?.(false)
    expect(confirmation()).toBeUndefined()
    expect(state.calls).toEqual([])
    expect(components(tree(), Input)[0]!.props.value).toBe('https://new.example.test/secret')
    expect(props.onSaved).not.toHaveBeenCalled()
  })

  it.each([
    { phone: '+442079460000', link: 'https://new.example.test/secret', fields: ['手机号', '短信接码链接'] },
    { phone: '+14155550100', link: 'https://new.example.test/secret', fields: ['短信接码链接'] },
    { phone: '+442079460000', link: account().smsOtpUrl, fields: ['手机号'] },
  ])('confirms the changed existing relations when picking $phone', ({ phone, link, fields }) => {
    pickNumber(phone, link)
    expect(state.calls).toEqual([])
    const description = text(components(confirmation()!, AlertDialogDescription)[0]!)
    for (const field of fields) expect(description).toContain(field)
    if (fields.includes('手机号')) {
      expect(description).toContain('+14155550100')
      expect(description).toContain(phone)
    }
    expect(description).not.toContain(link)
    confirmation()!.props.onOpenChange?.(false)
    expect(state.calls).toEqual([])
  })

  it('saves initial contact additions directly and preserves unrelated latest fields', async () => {
    props.account = account({ phone: '', smsOtpUrl: '' })
    state.latest = account({ phone: '', smsOtpUrl: '', note: 'latest note', updatedAt: '2026-11-03T00:00:00.000Z' })
    state.saved = account({ phone: '+442079460000', smsOtpUrl: 'https://new.example.test/secret', note: 'latest note' })
    pickNumber()
    await flushPromises()
    expect(confirmation()).toBeUndefined()
    expect(writes()).toHaveLength(1)
    expect(writes()[0]!.input).toMatchObject({
      id: 'account-1',
      expectedUpdatedAt: '2026-11-03T00:00:00.000Z',
      phone: '+442079460000',
      smsOtpUrl: 'https://new.example.test/secret',
      note: 'latest note',
    })
    expect(props.onSaved).toHaveBeenCalledExactlyOnceWith(state.saved)
  })

  it('prevents duplicate writes and closing while busy, retaining a sanitized failure for retry', async () => {
    const save = deferred<{ item: Account; created: boolean }>()
    state.saveResponse = save.promise
    editLink('https://new.example.test/secret')
    submitLink()
    const action = components(confirmation()!, AlertDialogAction)[0]!.props.onClick!
    action({ preventDefault() {} } as MouseEvent<HTMLButtonElement>)
    action({ preventDefault() {} } as MouseEvent<HTMLButtonElement>)
    await flushPromises()
    expect(writes()).toHaveLength(1)
    expect(components(confirmation()!, AlertDialogAction)[0]!.props.disabled).toBe(true)
    expect(components(confirmation()!, AlertDialogCancel)[0]!.props.disabled).toBe(true)
    expect(components(tree(), Input)[0]!.props.disabled).toBe(true)
    confirmation()!.props.onOpenChange?.(false)
    components(tree(), Popover)[0]!.props.onOpenChange?.(false)
    expect(confirmation()).toBeDefined()
    save.reject(new Error(`failed: ${props.account.password} ${props.account.smsOtpUrl}`))
    await flushPromises()
    expect(confirmation()).toBeDefined()
    expect(text(confirmation())).toContain('保存失败')
    expect(text(confirmation())).not.toContain(props.account.password)
    expect(text(confirmation())).not.toContain(props.account.smsOtpUrl)
    expect(components(tree(), Input)[0]!.props.value).toBe('https://new.example.test/secret')
    expect(props.onSaved).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    state.saveResponse = null
    confirm()
    await flushPromises()
    expect(writes()).toHaveLength(2)
    expect(writes()[1]!.input).toEqual(writes()[0]!.input)
    expect(props.onSaved).toHaveBeenCalledExactlyOnceWith(state.saved)
    expect(confirmation()).toBeUndefined()
  })

  it.each(['rendered', 'persisted'])(
    'does not overwrite a changed %s contact from an old confirmation',
    async (source) => {
      editLink('https://new.example.test/secret')
      submitLink()
      const replacement = account({ phone: '+33123456789', smsOtpUrl: 'https://replacement.example.test/private' })
      if (source === 'rendered') props.account = replacement
      else state.latest = replacement
      confirm()
      await flushPromises()
      expect(writes()).toEqual([])
      expect(confirmation()).toBeDefined()
      expect(text(confirmation())).toContain('已变化')
      expect(text(confirmation())).not.toContain(replacement.smsOtpUrl)
      expect(props.onSaved).not.toHaveBeenCalled()
    },
  )

  it('does not submit a retained confirmation after the plugin becomes unavailable', () => {
    pickNumber()
    const action = components(confirmation()!, AlertDialogAction)[0]!.props.onClick!
    props.ready = false
    expect(components(confirmation()!, AlertDialogAction)[0]!.props.disabled).toBe(true)
    action({ preventDefault() {} } as MouseEvent<HTMLButtonElement>)
    expect(state.calls).toEqual([])
    expect(confirmation()).toBeDefined()
  })

  it('blocks OTP reads and contact edits underneath an open confirmation', async () => {
    pickNumber()
    const read = components(tree(), Button).find(
      (node) => text(node.props.children) === '读取短信验证码',
    )!
    expect(read.props.disabled).toBe(true)
    read.props.onClick?.({} as MouseEvent<HTMLButtonElement>)
    await flushPromises()
    expect(state.calls).toEqual([])
    expect(components(tree(), NumberPoolList)[0]!.props.disabled).toBe(true)
  })
})
