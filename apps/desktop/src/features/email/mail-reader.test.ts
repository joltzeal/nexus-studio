import {
  type DependencyList,
  type EffectCallback,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Tabs } from '@/components/ui/tabs'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { getMessage, listMessages } from './api'
import { MailReader } from './mail-reader'
import { mailbox, message } from './test-fixtures'
import type { MailMessageDetail, MailMessagePage } from './types'

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
  listMessages: vi.fn(),
  getMessage: vi.fn(),
}))

let lifecycles: KernelHookHarness[]
function mountElement(element: ReactElement<Record<string, unknown>>) {
  const hooks = new KernelHookHarness(context)
  lifecycles.push(hooks)
  const tree = () =>
    hooks.render(() =>
      (element.type as (props: Record<string, unknown>) => ReactNode)(element.props),
    )
  tree()
  hooks.flushEffects()
  return { hooks, tree }
}
function folder(root: ReactNode) {
  return elements(root).find(
    (node) =>
      typeof node.type === 'function' && node.props.accountId && !node.props.messageId,
  )!
}
function detail(root: ReactNode) {
  return elements(root).find(
    (node) => typeof node.type === 'function' && node.props.messageId,
  )!
}
function click(root: ReactNode, label: string) {
  components(root, Button)
    .find(
      (node) =>
        node.props['aria-label'] === label || text(node.props.children).startsWith(label),
    )!
    .props.onClick?.({} as MouseEvent<HTMLButtonElement>)
}
const body = (id = 'message-1', text = 'Committed plaintext'): MailMessageDetail => ({
  ...message({ id }),
  to: [{ name: 'Reader', address: 'reader@example.test' }],
  body: text,
  truncated: false,
})

beforeEach(() => {
  lifecycles = []
  vi.mocked(listMessages)
    .mockReset()
    .mockResolvedValue({
      items: [message(), message({ id: 'message-2', subject: 'Second subject' })],
      nextCursor: 'opaque-page-2',
    })
  vi.mocked(getMessage).mockReset().mockResolvedValue(body())
})
afterEach(() => {
  for (const hooks of lifecycles) hooks.dispose()
  context.hooks = null
})

async function openFolder() {
  const rootHooks = new KernelHookHarness(context)
  lifecycles.push(rootHooks)
  const root = () =>
    rootHooks.render(() => MailReader({ account: mailbox(), onClose: () => {} }))
  const current = mountElement(folder(root()))
  await flushPromises()
  return { root, ...current }
}

describe('email reader request scopes', () => {
  it('uses the selected account and folder, and scopes a new list when the folder changes', async () => {
    const pending = deferred<MailMessagePage>()
    vi.mocked(listMessages).mockReturnValueOnce(pending.promise)
    const view = await openFolder()
    expect(listMessages).toHaveBeenCalledExactlyOnceWith({
      accountId: 'mailbox-1',
      folder: 'inbox',
    })
    const oldFolder = folder(view.root())
    components(view.root(), Tabs)[0]!.props.onValueChange?.('junkemail')
    const newFolder = folder(view.root())
    expect(newFolder.key).not.toBe(oldFolder.key)
    view.hooks.dispose()
    const next = mountElement(newFolder)
    await flushPromises()
    pending.resolve({
      items: [message({ subject: 'Obsolete inbox mail' })],
      nextCursor: null,
    })
    await flushPromises()
    expect(listMessages).toHaveBeenLastCalledWith({
      accountId: 'mailbox-1',
      folder: 'junkemail',
    })
    expect(text(next.tree())).not.toContain('Obsolete inbox mail')
  })

  it('navigates opaque cursors in both directions and removes the previous page detail', async () => {
    const view = await openFolder()
    click(view.tree(), 'Synthetic subject')
    expect(detail(view.tree()).props.messageId).toBe('message-1')
    click(view.tree(), '下一页邮件')
    expect(detail(view.tree())).toBeUndefined()
    await flushPromises()
    expect(listMessages).toHaveBeenLastCalledWith({
      accountId: 'mailbox-1',
      folder: 'inbox',
      cursor: 'opaque-page-2',
    })
    expect(text(view.tree())).toContain('第 2 页')
    click(view.tree(), '上一页邮件')
    await flushPromises()
    expect(listMessages).toHaveBeenLastCalledWith({
      accountId: 'mailbox-1',
      folder: 'inbox',
    })
    expect(
      components(view.tree(), Button).find(
        (node) => node.props['aria-label'] === '下一页邮件',
      )!.props.disabled,
    ).toBe(false)
    click(view.tree(), '下一页邮件')
    await flushPromises()
    expect(text(view.tree())).toContain('第 2 页')
  })

  it.each(['success', 'failure'])(
    'discards a late detail %s when another message is selected',
    async (outcome) => {
      const pending = deferred<MailMessageDetail>()
      vi.mocked(getMessage).mockReturnValueOnce(pending.promise)
      const view = await openFolder()
      click(view.tree(), 'Synthetic subject')
      const firstElement = detail(view.tree())
      const first = mountElement(firstElement)
      click(view.tree(), 'Second subject')
      const secondElement = detail(view.tree())
      expect(secondElement.key).not.toBe(firstElement.key)
      first.hooks.dispose()
      vi.mocked(getMessage).mockResolvedValueOnce(
        body('message-2', 'Current message body'),
      )
      const second = mountElement(secondElement)
      await flushPromises()
      if (outcome === 'success') pending.resolve(body('message-1', 'Obsolete detail'))
      else pending.reject(new Error('Obsolete detail failure'))
      await flushPromises()
      expect(getMessage).toHaveBeenLastCalledWith({
        accountId: 'mailbox-1',
        folder: 'inbox',
        messageId: 'message-2',
      })
      expect(text(second.tree())).toContain('Current message body')
      expect(text(second.tree())).not.toContain('Obsolete detail')
    },
  )

  it('renders mail as escaped plaintext and retains it with a visible safe error after a failed refresh', async () => {
    vi.mocked(getMessage).mockResolvedValueOnce(
      body('message-1', '<img src=x onerror=alert(1)>'),
    )
    const view = await openFolder()
    click(view.tree(), 'Synthetic subject')
    const selected = mountElement(detail(view.tree()))
    await flushPromises()
    const html = renderToStaticMarkup(selected.tree())
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img')
    vi.mocked(getMessage).mockRejectedValueOnce(
      new Error('refresh_token=synthetic-secret'),
    )
    click(selected.tree(), '刷新邮件详情')
    await flushPromises()
    expect(text(selected.tree())).toContain('<img src=x onerror=alert(1)>')
    expect(text(selected.tree())).toContain('读取失败')
    expect(text(selected.tree())).not.toContain('synthetic-secret')
  })

  it('drops late mail after the reader lifecycle closes', async () => {
    const pending = deferred<MailMessagePage>()
    vi.mocked(listMessages).mockReturnValueOnce(pending.promise)
    const view = await openFolder()
    view.hooks.dispose()
    pending.resolve({
      items: [message({ subject: 'Closed reader result' })],
      nextCursor: null,
    })
    await flushPromises()
    expect(text(view.tree())).not.toContain('Closed reader result')
  })
})
