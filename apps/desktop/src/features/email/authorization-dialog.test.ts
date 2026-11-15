import { type DependencyList, type EffectCallback, type MouseEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import {
  components,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { copyText } from '@/lib/clipboard'
import { openExternalUrl } from '@/lib/platform/external-url'
import {
  cancelEmailAuthorization,
  pollEmailAuthorization,
  startEmailAuthorization,
} from './api'
import { EmailAuthorizationDialog } from './authorization-dialog'
import { EmailRequestError } from './errors'
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
  startEmailAuthorization: vi.fn(),
  pollEmailAuthorization: vi.fn(),
  cancelEmailAuthorization: vi.fn(),
}))
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn() }))
vi.mock('@/lib/platform/external-url', () => ({ openExternalUrl: vi.fn() }))

const challenge = {
  authorizationId: '00000000-0000-4000-8000-000000000001',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://microsoft.com/devicelogin',
  expiresAt: '2026-11-14T01:15:00Z',
  intervalSeconds: 5,
}
let hooks: KernelHookHarness
const onClose = vi.fn()
const onAuthorized = vi.fn()
const tree = () =>
  hooks.render(() =>
    EmailAuthorizationDialog({ account: mailbox(), onClose, onAuthorized }),
  )
function click(label: string) {
  const button = components(tree(), Button).find(
    (node) => text(node.props.children) === label,
  )
  expect(button, label).toBeDefined()
  button!.props.onClick?.({} as MouseEvent<HTMLButtonElement>)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.mocked(startEmailAuthorization).mockResolvedValue(challenge)
  vi.mocked(pollEmailAuthorization).mockResolvedValue({
    status: 'pending',
    retryAfterSeconds: 5,
  })
  vi.mocked(cancelEmailAuthorization).mockResolvedValue(undefined)
  vi.mocked(openExternalUrl).mockResolvedValue(undefined)
  vi.mocked(copyText).mockResolvedValue(true)
  hooks = new KernelHookHarness(context)
  tree()
  hooks.flushEffects()
})
afterEach(() => {
  components(tree(), Dialog)[0]!.props.onOpenChange?.(false)
  hooks.dispose()
  context.hooks = null
  vi.useRealTimers()
})

describe('Microsoft write consent dialog', () => {
  it('starts only on demand, exposes the code and opens/copies only explicit user actions', async () => {
    expect(startEmailAuthorization).not.toHaveBeenCalled()
    expect(openExternalUrl).not.toHaveBeenCalled()
    click('开始微软授权')
    await flushPromises()
    expect(startEmailAuthorization).toHaveBeenCalledExactlyOnceWith(
      'mailbox-1',
      'reader@example.test',
    )
    expect(text(tree())).toContain('ABCD-EFGH')
    expect(text(tree())).toContain('Mail.ReadWrite')
    expect(text(tree())).toContain('User.Read')
    expect(openExternalUrl).not.toHaveBeenCalled()
    click('打开微软授权页面')
    await flushPromises()
    click('复制授权码')
    await flushPromises()
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(
      'https://microsoft.com/devicelogin',
    )
    expect(copyText).toHaveBeenCalledExactlyOnceWith('ABCD-EFGH')
    expect(onAuthorized).not.toHaveBeenCalled()
  })

  it('publishes only the saved account and stops polling after consent succeeds', async () => {
    click('开始微软授权')
    await flushPromises()
    vi.mocked(pollEmailAuthorization).mockResolvedValueOnce({
      status: 'authorized',
      account: mailbox({ transport: 'graph' }),
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect(onAuthorized).toHaveBeenCalledExactlyOnceWith(mailbox({ transport: 'graph' }))
    expect(cancelEmailAuthorization).toHaveBeenCalledExactlyOnceWith(
      challenge.authorizationId,
    )
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pollEmailAuthorization).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('expands actionable app/tenant recovery after a denied grant without closing', async () => {
    click('开始微软授权')
    await flushPromises()
    vi.mocked(pollEmailAuthorization).mockResolvedValueOnce({ status: 'denied' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(elements(tree()).find((node) => node.type === 'details')!.props.open).toBe(
      true,
    )
    expect(text(tree())).toContain('公共客户端')
    expect(text(tree())).toContain('管理员')
    expect(text(tree())).toContain('第三方 Client ID')
    expect(text(tree())).toContain('原凭据保持不变')
    expect(onAuthorized).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pollEmailAuthorization).toHaveBeenCalledTimes(1)
  })

  it('preserves an unsupported-client error and supports explicit cancellation', async () => {
    vi.mocked(startEmailAuthorization).mockRejectedValueOnce(
      new EmailRequestError('PERMISSION_DENIED'),
    )
    click('开始微软授权')
    await flushPromises()
    expect(text(tree())).toContain('联系应用所有者')
    expect(onAuthorized).not.toHaveBeenCalled()
    expect(pollEmailAuthorization).not.toHaveBeenCalled()
    click('取消')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('cancels an issued code without applying credentials or continuing polls', async () => {
    click('开始微软授权')
    await flushPromises()
    components(tree(), Dialog)[0]!.props.onOpenChange?.(false)
    expect(cancelEmailAuthorization).toHaveBeenCalledExactlyOnceWith(
      challenge.authorizationId,
    )
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pollEmailAuthorization).not.toHaveBeenCalled()
    expect(onAuthorized).not.toHaveBeenCalled()
  })
})
