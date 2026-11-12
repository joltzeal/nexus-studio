import {
  type DependencyList,
  type EffectCallback,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { LabeledSelect } from '@/components/ui/labeled-select'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import {
  linkMailboxToAccount,
  loadAccountLinkTargets,
  loadMailboxLinkTargets,
} from './accounts-link'
import { LinkAccountMailboxDialog, LinkMailboxAccountDialog } from './link-account-dialog'
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
vi.mock('./accounts-link', () => ({
  loadAccountLinkTargets: vi.fn(),
  loadMailboxLinkTargets: vi.fn(),
  linkMailboxToAccount: vi.fn(),
  unlinkMailboxFromAccount: vi.fn(),
}))
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

let hooks: KernelHookHarness
let content: () => ReactNode
const tree = () => hooks.render(content)
const onClose = vi.fn()
const onSaved = vi.fn()
const page = {
  items: [
    {
      id: 'account-1',
      account: 'seller@example.test',
      status: 'active' as const,
      mailbox: null,
    },
  ],
  total: 1,
  page: 1,
  pageSize: 10,
  storageDurable: true,
}

async function mount(element: ReactElement) {
  const Component = element.type as (props: typeof element.props) => ReactNode
  content = () => Component(element.props)
  tree()
  hooks.flushEffects()
  await flushPromises()
}

function submit() {
  const form = elements(tree()).find(
    (element) => element.type === 'form',
  ) as ReactElement<{ onSubmit?: (event: FormEvent<HTMLFormElement>) => void }>
  form.props.onSubmit?.({ preventDefault() {} } as FormEvent<HTMLFormElement>)
}

beforeEach(() => {
  vi.resetAllMocks()
  hooks = new KernelHookHarness(context)
  vi.mocked(loadAccountLinkTargets).mockResolvedValue(page)
  vi.mocked(linkMailboxToAccount).mockResolvedValue({
    mailbox: {
      pluginId: 'studio.email',
      mailboxId: mailbox().id,
      email: mailbox().email,
      linkedAt: '2026-11-12T10:00:00.000Z',
    },
    updatedAt: '2026-11-12T10:00:00.000Z',
    storageDurable: true,
  })
})
afterEach(() => {
  hooks.dispose()
  context.hooks = null
})

describe('account and mailbox pickers', () => {
  it('starts with a matching email query without writing a relationship', async () => {
    await mount(LinkMailboxAccountDialog({ mailbox: mailbox(), onClose }))
    expect(loadAccountLinkTargets).toHaveBeenCalledExactlyOnceWith({
      query: mailbox().email,
      page: 1,
    })
    expect(text(tree())).toContain('关联账号')
    expect(linkMailboxToAccount).not.toHaveBeenCalled()
    expect(
      components(tree(), Button).find((node) => text(node.props.children) === '关联账号')
        ?.props.disabled,
    ).toBe(true)
  })

  it('uses the selected account and closes only after a confirmed durable write', async () => {
    await mount(LinkMailboxAccountDialog({ mailbox: mailbox(), onClose }))
    components(tree(), LabeledSelect)[0]!.props.onValueChange('account-1')
    const write = deferred<Awaited<ReturnType<typeof linkMailboxToAccount>>>()
    vi.mocked(linkMailboxToAccount).mockReturnValueOnce(write.promise)
    submit()
    submit()
    expect(linkMailboxToAccount).toHaveBeenCalledExactlyOnceWith(
      'account-1',
      mailbox(),
      null,
    )
    expect(onClose).not.toHaveBeenCalled()
    write.resolve({
      mailbox: null,
      updatedAt: '2026-11-12T10:00:00.000Z',
      storageDurable: true,
    })
    await flushPromises()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preserves the picker and selection after a failed save', async () => {
    await mount(LinkMailboxAccountDialog({ mailbox: mailbox(), onClose }))
    components(tree(), LabeledSelect)[0]!.props.onValueChange('account-1')
    vi.mocked(linkMailboxToAccount).mockRejectedValueOnce(new Error('synthetic-secret'))
    submit()
    await flushPromises()
    expect(onClose).not.toHaveBeenCalled()
    expect(components(tree(), LabeledSelect)[0]!.props.value).toBe('account-1')
    expect(text(tree())).toContain('关联失败')
    expect(text(tree())).not.toContain('synthetic-secret')
  })

  it('suggests the account login email while preserving its current mailbox expectation', async () => {
    vi.mocked(loadMailboxLinkTargets).mockResolvedValue({
      ...page,
      items: [
        {
          id: mailbox().id,
          email: mailbox().email,
          enabled: true,
          status: 'active',
        },
      ],
    })
    const account = {
      id: 'account-1',
      account: 'seller@example.test',
      mailbox: {
        pluginId: 'studio.email' as const,
        mailboxId: mailbox().id,
        email: mailbox().email,
        linkedAt: '2026-11-12T10:00:00.000Z',
      },
    }
    await mount(LinkAccountMailboxDialog({ account, onClose, onSaved }))
    expect(loadMailboxLinkTargets).toHaveBeenCalledWith({
      query: 'seller@example.test',
      page: 1,
    })
    components(tree(), LabeledSelect)[0]!.props.onValueChange(mailbox().id)
    submit()
    await flushPromises()
    expect(linkMailboxToAccount).toHaveBeenCalledWith(
      account.id,
      { id: mailbox().id, email: mailbox().email },
      account.mailbox.mailboxId,
    )
    expect(onSaved).toHaveBeenCalledTimes(1)
  })
})
