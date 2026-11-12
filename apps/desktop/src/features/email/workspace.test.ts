import {
  type ChangeEvent,
  type DependencyList,
  type EffectCallback,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import {
  components,
  deferred,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import type { PluginView } from '@/lib/platform/native-plugins'
import { listMailboxes, queueRefresh } from './api'
import { EmailPage } from './email-page'
import { MailReader } from './mail-reader'
import { mailbox } from './test-fixtures'
import type { MailboxPage } from './types'

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
  listMailboxes: vi.fn(),
  queueRefresh: vi.fn(),
}))
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const plugin: PluginView = {
  id: 'studio.email',
  name: '邮箱',
  version: '1.0.0',
  apiVersion: 1,
  minCoreVersion: '0.1.0',
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

let hooks: KernelHookHarness
let workspace: () => ReactNode
const tree = () => hooks.render(workspace)
const button = (label: string) =>
  components(tree(), Button).find(
    (node) => node.props['aria-label'] === label || text(node.props.children) === label,
  )!
const click = (label: string) =>
  button(label).props.onClick?.({} as MouseEvent<HTMLButtonElement>)
const search = (value: string) =>
  components(tree(), Input)[0]!.props.onChange?.({
    target: { value },
  } as ChangeEvent<HTMLInputElement>)
const select = (label: string, value: string) =>
  components(tree(), LabeledSelect)
    .find((node) => node.props.ariaLabel === label)!
    .props.onValueChange(value)
const inventory = (patch: Partial<MailboxPage> = {}): MailboxPage => ({
  items: [mailbox()],
  total: 21,
  page: 1,
  pageSize: 20,
  storageDurable: true,
  ...patch,
})

async function mount() {
  tree()
  hooks.flushEffects()
  await flushPromises()
}

beforeEach(() => {
  vi.mocked(listMailboxes).mockReset().mockResolvedValue(inventory())
  vi.mocked(queueRefresh).mockReset().mockResolvedValue({ queued: 1, skipped: 0 })
  hooks = new KernelHookHarness(context)
  const element = EmailPage({ plugin, hostAvailable: true })
  workspace = element.type as () => ReactNode
})
afterEach(() => {
  hooks.dispose()
  context.hooks = null
  vi.useRealTimers()
})

describe('email workspace asynchronous interactions', () => {
  it('polls the current server page every five seconds without overlapping a slow summary read', async () => {
    vi.useFakeTimers()
    const pending = deferred<MailboxPage>()
    vi.mocked(listMailboxes).mockReturnValueOnce(pending.promise)
    await mount()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(listMailboxes).toHaveBeenCalledTimes(1)
    expect(button('刷新列表').props.disabled).toBe(true)
    pending.resolve(inventory())
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(listMailboxes).toHaveBeenCalledTimes(2)
    expect(listMailboxes).toHaveBeenLastCalledWith({ page: 1, pageSize: 20 })
  })

  it('sends server pagination/filter inputs and discards an older in-flight list', async () => {
    await mount()
    const stale = deferred<MailboxPage>()
    vi.mocked(listMailboxes).mockReturnValueOnce(stale.promise)
    click('刷新列表')
    search('latest-query')
    select('筛选邮箱状态', 'error')
    expect(listMailboxes).toHaveBeenCalledTimes(2)
    stale.resolve(inventory({ items: [mailbox({ email: 'stale@example.test' })] }))
    await flushPromises()
    expect(listMailboxes).toHaveBeenLastCalledWith({
      query: 'latest-query',
      status: 'error',
      page: 1,
      pageSize: 20,
    })
    expect(text(tree())).not.toContain('stale@example.test')
    select('每页邮箱数', '50')
    await flushPromises()
    expect(listMailboxes).toHaveBeenLastCalledWith({
      query: 'latest-query',
      status: 'error',
      page: 1,
      pageSize: 50,
    })
  })

  it('refreshes selected tokens without duplicate queues and clears selection on page navigation', async () => {
    await mount()
    components(tree(), Checkbox)
      .find((node) => node.props['aria-label'] === '全选当前页邮箱')!
      .props.onCheckedChange?.(true)
    const pending = deferred<{ queued: number; skipped: number }>()
    vi.mocked(queueRefresh).mockReturnValueOnce(pending.promise)
    const enqueue = button('刷新所选 token').props.onClick!
    enqueue({} as MouseEvent<HTMLButtonElement>)
    enqueue({} as MouseEvent<HTMLButtonElement>)
    expect(queueRefresh).toHaveBeenCalledExactlyOnceWith(['mailbox-1'])
    pending.resolve({ queued: 1, skipped: 0 })
    await flushPromises()
    click('下一页邮箱')
    await flushPromises()
    expect(listMailboxes).toHaveBeenLastCalledWith({ page: 2, pageSize: 20 })
    expect(text(tree())).toContain('已选 0')
  })

  it('keeps the committed table and displays a safe error when manual refresh fails', async () => {
    await mount()
    vi.mocked(listMailboxes).mockRejectedValueOnce(
      new Error('refresh_token=synthetic-secret'),
    )
    click('刷新列表')
    await flushPromises()
    expect(text(tree())).toContain('reader@example.test')
    expect(
      components(tree(), AlertDescription)
        .map((node) => text(node.props.children))
        .join(''),
    ).toContain('读取失败')
    expect(text(tree())).not.toContain('synthetic-secret')
  })

  it('combines filter events before a render without dropping the latest query', async () => {
    await mount()
    const rendered = tree()
    const input = components(rendered, Input)[0]!
    const status = components(rendered, LabeledSelect).find(
      (node) => node.props.ariaLabel === '筛选邮箱状态',
    )!
    input.props.onChange?.({
      target: { value: 'latest-query' },
    } as ChangeEvent<HTMLInputElement>)
    status.props.onValueChange('error')
    await flushPromises()
    expect(listMailboxes).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 20,
      query: 'latest-query',
      status: 'error',
    })
  })

  it('keeps the active reader mounted when polling only changes token refresh timestamps', async () => {
    await mount()
    click('读取 reader@example.test 的邮件')
    const reader = components(tree(), MailReader)[0]!
    vi.mocked(listMailboxes).mockResolvedValueOnce(
      inventory({
        items: [mailbox({ updatedAt: '2026-11-12T12:01:00Z', refreshing: true })],
      }),
    )
    click('刷新列表')
    await flushPromises()
    expect(components(tree(), MailReader)[0]!.key).toBe(reader.key)
    expect(components(tree(), MailReader)[0]!.props.account.refreshing).toBe(true)
  })

  it('replaces the reader scope if the email identity is edited externally', async () => {
    await mount()
    click('读取 reader@example.test 的邮件')
    const reader = components(tree(), MailReader)[0]!
    vi.mocked(listMailboxes).mockResolvedValueOnce(
      inventory({
        items: [mailbox({ email: 'changed@example.test' })],
      }),
    )
    click('刷新列表')
    await flushPromises()
    expect(components(tree(), MailReader)[0]!.key).not.toBe(reader.key)
  })

  it('stops polling and discards pending results when its plugin workspace unmounts', async () => {
    vi.useFakeTimers()
    await mount()
    const late = deferred<MailboxPage>()
    vi.mocked(listMailboxes).mockReturnValueOnce(late.promise)
    click('刷新列表')
    hooks.dispose()
    late.resolve(inventory({ items: [mailbox({ email: 'late@example.test' })] }))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(listMailboxes).toHaveBeenCalledTimes(2)
    expect(text(tree())).not.toContain('late@example.test')
  })
})
