import { type ChangeEvent, type FormEvent, type MouseEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
} from '@/components/ui/alert-dialog'
import { DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { NumberPoolPicker } from '@/features/sim8/number-picker'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { AccountEditor } from './account-editor'
import { observedAccount } from './account-observation-test-support'

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
  }
})

let hooks: KernelHookHarness
let props: Parameters<typeof AccountEditor>[0]
const tree = () => hooks.render(() => AccountEditor(props))
function change(id: string, value: string) {
  components(tree(), Input)
    .find((node) => node.props.id === id)!
    .props.onChange?.({ target: { value } } as ChangeEvent<HTMLInputElement>)
}
function submit() {
  const form = elements(tree()).find((node) => node.type === 'form')!
  ;(form.props.onSubmit as (event: FormEvent) => void)({
    preventDefault: vi.fn(),
  } as unknown as FormEvent)
}
function confirm() {
  components(tree(), AlertDialogAction)[0]!.props.onClick?.({
    preventDefault: vi.fn(),
  } as unknown as MouseEvent<HTMLButtonElement>)
}
const confirmation = () => components(tree(), AlertDialog).find((node) => node.props.open)

beforeEach(() => {
  vi.resetAllMocks()
  hooks = new KernelHookHarness(state)
  props = {
    account: observedAccount(),
    ready: true,
    onSave: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
  }
})
afterEach(() => hooks.dispose())

describe('account editor destructive contact changes', () => {
  it('reviews both existing relations when a different number is picked from the pool', async () => {
    components(tree(), NumberPoolPicker)[0]!.props.onPick({
      tel: '+14155550199',
      api: 'https://example.test/sms-pool?token=synthetic',
    })
    submit()
    expect(props.onSave).not.toHaveBeenCalled()
    const description = text(components(tree(), AlertDialogDescription)[0]!)
    expect(description).toContain('更换手机号')
    expect(description).toContain('替换短信接码链接')
    expect(description).not.toContain('token=synthetic')
    confirm()
    await flushPromises()
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: '+14155550199',
        smsOtpUrl: 'https://example.test/sms-pool?token=synthetic',
        password: props.account!.password,
        emailOtpUrl: props.account!.emailOtpUrl,
      }),
    )
  })

  it.each([
    ['account-phone', '', '清空手机号'],
    ['account-phone', '+14155550199', '更换手机号'],
    ['account-sms-otp', '', '清空短信接码链接'],
    [
      'account-sms-otp',
      'https://example.test/new-sms?token=synthetic',
      '替换短信接码链接',
    ],
    ['account-email-otp', '', '清空邮箱接码链接'],
    [
      'account-email-otp',
      'https://example.test/new-mail?token=synthetic',
      '替换邮箱接码链接',
    ],
  ])('requires confirmation before saving %s as %j', async (field, value, relation) => {
    change(field, value)
    submit()
    await flushPromises()

    expect(props.onSave).not.toHaveBeenCalled()
    expect(confirmation()).toBeDefined()
    const description = text(components(tree(), AlertDialogDescription)[0]!)
    expect(description).toContain('seller@example.test')
    expect(description).toContain(relation)
    expect(description).toContain('所有关联窗口')
    expect(description).not.toContain(props.account!.password)
    expect(description).not.toContain('https://')
    expect(description).not.toContain('token=synthetic')

    confirm()
    await flushPromises()
    expect(props.onSave).toHaveBeenCalledTimes(1)
    expect(confirmation()).toBeUndefined()
  })

  it('cancels without a write and preserves the edited draft for a later confirmation', async () => {
    change('account-phone', '')
    change('account-note', 'retained draft')
    submit()
    expect(props.onSave).not.toHaveBeenCalled()
    expect(components(tree(), AlertDialogCancel)[0]!.props.disabled).toBe(false)
    confirmation()!.props.onOpenChange?.(false)
    expect(confirmation()).toBeUndefined()
    expect(props.onSave).not.toHaveBeenCalled()
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(
      components(tree(), Input).find((node) => node.props.id === 'account-phone')!.props
        .value,
    ).toBe('')
    submit()
    confirm()
    await flushPromises()
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: '',
        note: 'retained draft',
        smsOtpUrl: props.account!.smsOtpUrl,
      }),
    )
  })

  it('retains the confirmation and draft after failure, blocks duplicate requests and closing while busy', async () => {
    const write = deferred<void>()
    vi.mocked(props.onSave).mockReturnValueOnce(write.promise)
    change('account-email-otp', '')
    submit()
    const action = components(tree(), AlertDialogAction)[0]!.props.onClick!
    const event = { preventDefault: vi.fn() } as unknown as MouseEvent<HTMLButtonElement>
    action(event)
    action(event)
    submit()
    confirmation()!.props.onOpenChange?.(false)
    const preventDefault = vi.fn()
    components(tree(), DialogContent)[0]!.props.onEscapeKeyDown?.({
      preventDefault,
    } as unknown as KeyboardEvent)
    expect(props.onSave).toHaveBeenCalledTimes(1)
    expect(confirmation()).toBeDefined()
    expect(components(tree(), AlertDialogAction)[0]!.props.disabled).toBe(true)
    expect(components(tree(), AlertDialogCancel)[0]!.props.disabled).toBe(true)
    expect(preventDefault).toHaveBeenCalledOnce()

    write.reject(
      new Error(`write failed ${props.account!.password} ${props.account!.emailOtpUrl}`),
    )
    await flushPromises()
    expect(confirmation()).toBeDefined()
    expect(text(tree())).toContain('保存失败')
    expect(text(components(tree(), AlertDialogDescription)[0]!)).not.toContain('https://')
    expect(text(tree())).not.toContain(props.account!.password)
    expect(text(tree())).not.toContain(props.account!.emailOtpUrl)
    expect(components(tree(), AlertDialogAction)[0]!.props.disabled).toBe(false)
    confirm()
    await flushPromises()
    expect(props.onSave).toHaveBeenCalledTimes(2)
    expect(confirmation()).toBeUndefined()
  })

  it('blocks an already opened confirmation when the plugin becomes unavailable', () => {
    change('account-phone', '')
    submit()
    props.ready = false
    expect(components(tree(), AlertDialogAction)[0]!.props.disabled).toBe(true)
    confirm()
    expect(props.onSave).not.toHaveBeenCalled()
    expect(confirmation()).toBeDefined()
  })

  it('saves ordinary edits and initial contact additions without a destructive prompt', async () => {
    props.account = observedAccount({ phone: '', smsOtpUrl: '', emailOtpUrl: '' })
    change('account-phone', '+14155550199')
    change('account-sms-otp', 'https://example.test/new-sms')
    change('account-email-otp', 'https://example.test/new-mail')
    change('account-note', 'new note')
    submit()
    await flushPromises()
    expect(props.onSave).toHaveBeenCalledTimes(1)
    expect(confirmation()).toBeUndefined()
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: props.account.updatedAt,
        password: props.account.password,
        phone: '+14155550199',
        note: 'new note',
      }),
    )
  })
})
