import { type DependencyList, type EffectCallback } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { listPlugins, type PluginView } from '@/lib/platform/native-plugins'
import {
  components,
  deferred,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { AccountMailboxPopover } from './account-mailbox-popover'
import { resolveLinkedMailbox, unlinkMailboxFromAccount } from './accounts-link'
import { MailReader } from './mail-reader'
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
  resolveLinkedMailbox: vi.fn(),
  unlinkMailboxFromAccount: vi.fn(),
}))
vi.mock('@/lib/platform/native-plugins', async (original) => ({
  ...(await original<typeof import('@/lib/platform/native-plugins')>()),
  listPlugins: vi.fn(),
}))
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

let hooks: KernelHookHarness
let props: Parameters<typeof AccountMailboxPopover>[0]
const tree = () => hooks.render(() => AccountMailboxPopover(props))
const click = (label: string) => {
  const button = components(tree(), Button).find(
    (item) => item.props['aria-label'] === label || text(item.props.children) === label,
  )
  button!.props.onClick?.({} as never)
}

beforeEach(() => {
  vi.resetAllMocks()
  hooks = new KernelHookHarness(context)
  const plugin: PluginView = {
    id: 'studio.email',
    name: '邮箱管理',
    version: '1.0.0',
    apiVersion: 1,
    minCoreVersion: '0.1.27',
    capabilities: ['email.provider'],
    granted: ['email.provider'],
    permissions: {
      networkDomains: [],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    },
    source: 'installed',
    state: 'running',
    enabled: true,
    methods: [],
    status: { pid: 123 },
    lastError: null,
    storageDurable: true,
    secretSlots: [],
    sourceDirectory: null,
  }
  vi.mocked(listPlugins).mockResolvedValue([plugin])
  props = {
    account: {
      id: 'account-1',
      account: 'seller@example.test',
      mailbox: {
        pluginId: 'studio.email',
        mailboxId: mailbox().id,
        email: mailbox().email,
        linkedAt: '2026-11-12T10:00:00.000Z',
      },
    },
    ready: true,
    onChanged: vi.fn(),
    onPendingChange: vi.fn(),
  }
  tree()
  hooks.flushEffects()
})
afterEach(() => {
  hooks.dispose()
  context.hooks = null
})

describe('account mailbox entry', () => {
  it('displays the persisted mailbox without reading email on initial render', () => {
    expect(text(tree())).toContain(mailbox().email)
    expect(resolveLinkedMailbox).not.toHaveBeenCalled()
    expect(unlinkMailboxFromAccount).not.toHaveBeenCalled()
  })

  it('opens mail only after resolving the exact bound mailbox', async () => {
    vi.mocked(resolveLinkedMailbox).mockResolvedValueOnce(mailbox())
    click('查看邮件')
    await flushPromises()
    expect(resolveLinkedMailbox).toHaveBeenCalledWith(props.account.mailbox)
    expect(components(tree(), MailReader)[0]?.props.account).toEqual(mailbox())
    expect(props.onChanged).not.toHaveBeenCalled()
  })

  it('keeps a missing mailbox closed and shows a fixed error', async () => {
    vi.mocked(resolveLinkedMailbox).mockRejectedValueOnce(new Error('synthetic-secret'))
    click('查看邮件')
    await flushPromises()
    expect(components(tree(), MailReader)).toHaveLength(0)
    expect(text(tree())).toContain('无法打开关联邮箱')
    expect(text(tree())).not.toContain('synthetic-secret')
  })

  it('unlinks once, blocks other mutations and updates the row only after persistence', async () => {
    const pending = deferred<Awaited<ReturnType<typeof unlinkMailboxFromAccount>>>()
    vi.mocked(unlinkMailboxFromAccount).mockReturnValueOnce(pending.promise)
    click('解除关联')
    click('解除关联')
    expect(unlinkMailboxFromAccount).toHaveBeenCalledExactlyOnceWith(
      props.account.id,
      props.account.mailbox!.mailboxId,
    )
    expect(props.onPendingChange).toHaveBeenCalledWith(true)
    expect(props.onChanged).not.toHaveBeenCalled()
    const receipt = {
      mailbox: null,
      updatedAt: '2026-11-12T10:01:00.000Z',
      storageDurable: true,
    }
    pending.resolve(receipt)
    await flushPromises()
    expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(receipt)
    expect(props.onPendingChange).toHaveBeenLastCalledWith(false)
  })
})
