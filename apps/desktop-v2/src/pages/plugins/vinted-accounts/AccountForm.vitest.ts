import type { ChangeEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Alert, Button, DialogModal, Input, Select } from '@proxyshard/shardx-ui-kit'
import {
  ComponentHooks,
  components,
  flushPromises,
} from '../../../raccoon/plugins/component.test-support'
import { AccountForm } from './AccountForm'
import { Sim8NumberPicker } from './Sim8NumberPicker'

const state = vi.hoisted(() => ({ hooks: null as ComponentHooks | null }))
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
    useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) =>
      state.hooks ? state.hooks.effect(callback, deps) : react.useEffect(callback, deps),
  }
})
vi.mock('@proxyshard/shardx-ui-kit', () => ({
  Alert: () => null,
  Button: () => null,
  DialogModal: () => null,
  Input: () => null,
  Select: () => null,
  Textarea: () => null,
}))
vi.mock('./Sim8NumberPicker', () => ({ Sim8NumberPicker: () => null }))

let props: Parameters<typeof AccountForm>[0]
const tree = () => {
  const render = () => state.hooks!.render(() => AccountForm(props))
  render()
  state.hooks!.flush()
  return render()
}
const form = () =>
  components(tree(), DialogModal).find((node) => node.props.confirmVariant !== 'error')!
const confirmation = () =>
  components(tree(), DialogModal).find((node) => node.props.confirmVariant === 'error')
const change = (label: string, value: string) =>
  components(tree(), Input)
    .find((node) => node.props.label === label)!
    .props.onChange?.({ target: { value } } as ChangeEvent<HTMLInputElement>)

beforeEach(() => {
  state.hooks = new ComponentHooks()
  props = {
    account: {
      id: 'account',
      loginMethod: 'email',
      account: 'seller@example.test',
      password: 'private-password',
      phone: '+14155550100',
      smsOtpUrl: 'https://sms.example/?token=private',
      emailOtpUrl: 'https://mail.example/?token=private',
      note: '',
      status: 'unknown',
      homepageUrl: '',
      address: null,
      mailbox: null,
      createdAt: '2026-11-19T00:00:00Z',
      updatedAt: '2026-11-19T00:00:00Z',
    },
    busy: false,
    error: null,
    onSave: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
  }
})
afterEach(() => {
  state.hooks?.dispose()
  state.hooks = null
})

describe('v2 account form contact review', () => {
  it('uses unknown for a new account and offers the unknown option', () => {
    props.account = null
    const status = components(tree(), Select).find(
      (node) => node.props.label === '账号状态',
    )!
    expect(status.props.value).toBe('unknown')
    expect(status.props.options).toEqual([
      { value: 'unknown', label: '未知' },
      { value: 'active', label: '正常' },
      { value: 'pending', label: '待验证' },
      { value: 'limited', label: '受限' },
      { value: 'blocked', label: '封禁' },
    ])
  })
  it('blocks clearing an existing nonempty password before saving', () => {
    change('密码', '')
    expect(form().props.isDisabled).toBe(true)
    form().props.onConfirm?.()
    expect(props.onSave).not.toHaveBeenCalled()
    expect(
      components(tree(), Input).find((node) => node.props.label === '密码')?.props.hint,
    ).toContain('不可清空')
  })
  it('allows an imported account with an originally empty password to stay empty', async () => {
    props.account = { ...props.account!, password: '' }
    expect(form().props.isDisabled).toBe(false)
    form().props.onConfirm?.()
    await flushPromises()
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ password: '', status: 'unknown' }),
    )
    expect(
      components(tree(), Input).find((node) => node.props.label === '密码')?.props.hint,
    ).toContain('可暂时留空')
  })
  it('requires a password for a manually added account', () => {
    props.account = null
    change('登录邮箱或账号', 'new@example.test')
    expect(form().props.isDisabled).toBe(true)
    form().props.onConfirm?.()
    expect(props.onSave).not.toHaveBeenCalled()
    change('密码', 'new-password')
    expect(form().props.isDisabled).toBe(false)
  })
  it('picks number and SMS link together and reviews saved contact changes without leaking secrets', async () => {
    components(tree(), Sim8NumberPicker)[0]!.props.onPick(
      {
        tel: '+14155550199',
        api: 'https://new.example/?token=new-secret',
      },
      'installed:first',
    )
    form().props.onConfirm?.()
    expect(props.onSave).not.toHaveBeenCalled()
    const review = confirmation()!
    expect(review.props.subtitle).toContain('更换手机号')
    expect(review.props.subtitle).toContain('替换短信接码链接')
    expect(review.props.subtitle).toContain('所有关联 Profile')
    expect(review.props.subtitle).not.toContain('https://')
    expect(review.props.subtitle).not.toContain('private-password')
    review.props.onConfirm?.()
    await flushPromises()
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        phone: '+14155550199',
        smsOtpUrl: 'https://new.example/?token=new-secret',
        emailOtpUrl: props.account!.emailOtpUrl,
        status: 'unknown',
      }),
    )
  })
  it('cancel preserves the edited draft and clearing an existing link requires confirmation', () => {
    change('邮箱验证码链接', '')
    form().props.onConfirm?.()
    expect(confirmation()?.props.subtitle).toContain('清空邮箱接码链接')
    confirmation()!.props.onCancel?.()
    expect(confirmation()).toBeUndefined()
    expect(props.onSave).not.toHaveBeenCalled()
    expect(
      components(tree(), Input).find((node) => node.props.label === '邮箱验证码链接')
        ?.props.value,
    ).toBe('')
  })
  it('locks duplicate submission and closing, then preserves a failed confirmation for retry', async () => {
    let reject: (reason: Error) => void = () => {}
    props.onSave = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail
        }),
    )
    change('手机号', '')
    form().props.onConfirm?.()
    const review = confirmation()!
    review.props.onConfirm?.()
    review.props.onConfirm?.()
    review.props.onCancel?.()
    form().props.onCancel?.()
    expect(props.onSave).toHaveBeenCalledOnce()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(confirmation()).toBeDefined()
    const footer = confirmation()!.props.footer
    expect(components(footer, Button).every((button) => button.props.disabled)).toBe(true)
    reject(new Error('https://private.example/?token=secret'))
    await flushPromises()
    expect(confirmation()).toBeDefined()
    expect(
      String(components(confirmation()!.props.children, Alert)[0]?.props.children),
    ).not.toContain('token=secret')
    props.onSave = vi.fn().mockResolvedValue(undefined)
    confirmation()!.props.onConfirm?.()
    await flushPromises()
    expect(props.onSave).toHaveBeenCalledOnce()
  })
  it('rejects a changed account revision before committing an existing confirmation', () => {
    change('手机号', '')
    form().props.onConfirm?.()
    props.account = { ...props.account!, updatedAt: '2026-11-19T00:00:01Z' }
    confirmation()!.props.onConfirm?.()
    expect(props.onSave).not.toHaveBeenCalled()
  })
})
