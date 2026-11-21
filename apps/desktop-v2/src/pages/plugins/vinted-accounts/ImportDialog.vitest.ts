import type { ChangeEvent } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  AlertModal,
  Checkbox,
  DialogModal,
  Input,
  Textarea,
} from '@proxyshard/shardx-ui-kit'
import {
  ComponentHooks,
  components,
  flushPromises,
} from '../../../raccoon/plugins/component.test-support'
import { ImportDialog } from './ImportDialog'

const state = vi.hoisted(() => ({ hooks: null as ComponentHooks | null }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) =>
      state.hooks ? state.hooks.effect(callback, deps) : react.useEffect(callback, deps),
  }
})
vi.mock('@proxyshard/shardx-ui-kit', () => ({
  Alert: () => null,
  AlertModal: () => null,
  Button: () => null,
  Checkbox: () => null,
  DialogModal: () => null,
  Input: () => null,
  Select: () => null,
  Textarea: () => null,
}))

let props: Parameters<typeof ImportDialog>[0]
const tree = () => {
  const render = () => state.hooks!.render(() => ImportDialog(props))
  render()
  state.hooks!.flush()
  return render()
}
const paste = () =>
  components(tree(), Textarea).find((node) => node.props.rows === 12)!.props.onChange!({
    target: { value: '账号,密码\nseller,secret' },
  } as ChangeEvent<HTMLTextAreaElement>)
beforeEach(() => {
  state.hooks = new ComponentHooks()
  props = {
    busy: false,
    error: null,
    mailboxTargets: null,
    existingAccounts: [
      { id: 'existing', account: 'existing@example.test', loginMethod: 'email' },
    ],
    onClose: vi.fn(),
    onImportMailboxes: vi.fn(),
    onFileImport: vi.fn().mockResolvedValue(undefined),
  }
})
afterEach(() => {
  state.hooks?.dispose()
  state.hooks = null
})

it('reviews an existing account pool before importing the captured file contents', () => {
  paste()
  components(tree(), DialogModal)[0]!.props.onConfirm?.()
  expect(props.onFileImport).not.toHaveBeenCalled()
  const review = components(tree(), AlertModal)[0]!
  expect(review.props.open).toBe(true)
  review.props.onConfirm?.()
  expect(props.onFileImport).toHaveBeenCalledExactlyOnceWith('accounts.csv', {
    text: '账号,密码\nseller,secret',
  })
})

it('imports directly into an empty pool and protects a busy confirmation from closing', () => {
  props.existingAccounts = []
  paste()
  components(tree(), DialogModal)[0]!.props.onConfirm?.()
  expect(props.onFileImport).toHaveBeenCalledOnce()
  props.busy = true
  components(tree(), DialogModal)[0]!.props.onOpenChange?.(false)
  expect(props.onClose).not.toHaveBeenCalled()
})

it('initially selects all available mailbox identities and creates unknown accounts', () => {
  props.mailboxTargets = [
    { id: 'one', email: 'one@example.test' },
    { id: 'two', email: 'two@example.test' },
  ]
  expect(components(tree(), Checkbox).filter((node) => node.props.checked)).toHaveLength(
    2,
  )
  components(tree(), DialogModal)[0]!.props.onConfirm?.()
  expect(props.onImportMailboxes).toHaveBeenCalledWith(
    expect.objectContaining({
      status: 'unknown',
      mailboxes: [
        { mailboxId: 'one', email: 'one@example.test' },
        { mailboxId: 'two', email: 'two@example.test' },
      ],
    }),
  )
})

it.each(['csv', 'txt'])(
  'accepts a 400 KiB %s text file without base64 expansion',
  async (extension) => {
    const file = new File(['x'.repeat(400 * 1024)], `accounts.${extension}`)
    const input = components(tree(), Input).find((node) => node.props.type === 'file')!
    input.props.onChange!({
      target: { files: [file] },
    } as unknown as ChangeEvent<HTMLInputElement>)
    await flushPromises()
    const text = components(tree(), Textarea).find((node) => node.props.rows === 12)!
    expect((text.props.value as string).length).toBe(400 * 1024)
    expect(components(tree(), DialogModal)[0]!.props.isDisabled).toBe(false)
  },
)
