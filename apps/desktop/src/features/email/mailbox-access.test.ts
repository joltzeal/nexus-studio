import {
  type ChangeEvent,
  type DependencyList,
  type EffectCallback,
  type FormEvent,
  type ReactNode,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup } from '@/components/ui/toggle-group'
import {
  components,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { importMailboxes, saveMailbox } from './api'
import { ImportMailboxesDialog } from './import-dialog'
import { MailboxEditor } from './mailbox-editor'
import { mailbox } from './test-fixtures'

const context = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      context.hooks ? context.hooks.state(initial) : react.useState(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      context.hooks ? context.hooks.effect(effect, deps) : react.useEffect(effect, deps),
    useSyncExternalStore: <T>(
      subscribe: (callback: () => void) => () => void,
      snapshot: () => T,
      server: () => T,
    ) =>
      context.hooks
        ? snapshot()
        : react.useSyncExternalStore(subscribe, snapshot, server),
  }
})
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  importMailboxes: vi.fn(),
  saveMailbox: vi.fn(),
}))
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn() } }))

let hooks: KernelHookHarness
beforeEach(() => {
  hooks = new KernelHookHarness(context)
  vi.mocked(importMailboxes)
    .mockReset()
    .mockResolvedValue({ total: 1, inserted: 1, skipped: 0, errors: [] })
  vi.mocked(saveMailbox)
    .mockReset()
    .mockResolvedValue(mailbox({ transport: 'imap' }))
})
afterEach(() => {
  hooks.dispose()
  context.hooks = null
})

function mount(render: () => ReactNode) {
  const tree = () => hooks.render(render)
  tree()
  hooks.flushEffects()
  return tree
}

function submit(root: ReactNode) {
  const handler = elements(root).find((node) => node.type === 'form')!.props.onSubmit
  if (typeof handler !== 'function') throw new Error('Expected a form submit handler')
  handler({ preventDefault() {} } as FormEvent)
}

function selectTransport(root: ReactNode, value: string) {
  const { props } = components(root, ToggleGroup)[0]!
  if (props.type !== 'single') throw new Error('Expected a single transport choice')
  props.onValueChange?.(value)
}

describe('Microsoft mailbox access selection', () => {
  it('imports four-field accounts through OAuth IMAP only after an explicit selection', async () => {
    const imported = vi.fn()
    const tree = mount(() =>
      ImportMailboxesDialog({ onClose() {}, onImported: imported }),
    )
    expect(components(tree(), ToggleGroup)[0]!.props.value).toBe('graph')
    selectTransport(tree(), 'imap')
    expect(text(tree())).toContain('IMAP.AccessAsUser.All')
    const value =
      'reader@example.test----synthetic-password----00000000-0000-4000-8000-000000000001----synthetic-refresh'
    components(tree(), Textarea)[0]!.props.onChange?.({
      target: { value },
    } as ChangeEvent<HTMLTextAreaElement>)
    submit(tree())
    await flushPromises()
    expect(importMailboxes).toHaveBeenCalledExactlyOnceWith(value, 'imap')
    expect(imported).toHaveBeenCalledOnce()
  })

  it('keeps Graph available as an explicit choice and explains its separate write permission', async () => {
    const tree = mount(() => ImportMailboxesDialog({ onClose() {}, onImported() {} }))
    selectTransport(tree(), 'graph')
    expect(components(tree(), ToggleGroup)[0]!.props.value).toBe('graph')
    expect(text(tree())).toContain('Mail.ReadWrite')
    expect(text(tree())).toContain('不能')
    expect(importMailboxes).not.toHaveBeenCalled()
  })

  it('preserves existing Graph credentials until the user saves an explicit IMAP change', async () => {
    const account = mailbox({
      clientId: '00000000-0000-4000-8000-000000000001',
    })
    const saved = vi.fn()
    const tree = mount(() => MailboxEditor({ account, onClose() {}, onSaved: saved }))
    expect(components(tree(), ToggleGroup)[0]!.props.value).toBe('graph')
    expect(text(tree())).toContain('Mail.ReadWrite')
    selectTransport(tree(), 'imap')
    expect(saveMailbox).not.toHaveBeenCalled()
    expect(text(tree())).toContain('IMAP.AccessAsUser.All')
    expect(
      components(tree(), Input).find((node) => node.props.id === 'email-refresh-token')!
        .props.value,
    ).toBe('')
    submit(tree())
    await flushPromises()
    expect(saveMailbox).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: account.id,
        transport: 'imap',
        refreshToken: '',
      }),
    )
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ transport: 'imap' }))
  })
})
