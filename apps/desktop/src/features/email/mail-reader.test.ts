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
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog } from '@/components/ui/dialog'
import { Tabs } from '@/components/ui/tabs'
import {
  components,
  deferred,
  elements,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { copyText } from '@/lib/clipboard'
import { getMessage, listMessages, setMessagesRead } from './api'
import { EmailRequestError } from './errors'
import { MailReader } from './mail-reader'
import { mailbox, message } from './test-fixtures'
import { mailHtmlDocument, type MailMessageDetail, type MailMessagePage } from './types'

const context = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      context.hooks ? context.hooks.state(initial) : react.useState(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      context.hooks ? context.hooks.effect(effect, deps) : react.useEffect(effect, deps),
    useMemo: <T>(factory: () => T, deps: DependencyList) =>
      context.hooks ? factory() : react.useMemo(factory, deps),
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
  setMessagesRead: vi.fn(),
}))
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn() }))

let lifecycles: KernelHookHarness[]
function mount(element: ReactElement<Record<string, unknown>>) {
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
function detailElement(root: ReactNode) {
  return elements(root).find(
    (node) => typeof node.type === 'function' && node.props.store,
  )!
}
function click(root: ReactNode, label: string) {
  const button = components(root, Button).find(
    (node) =>
      node.props['aria-label'] === label || text(node.props.children).startsWith(label),
  )
  expect(button, label).toBeDefined()
  button!.props.onClick?.({} as MouseEvent<HTMLButtonElement>)
}
function check(root: ReactNode, label: string, value: boolean) {
  components(root, Checkbox)
    .find((node) => node.props['aria-label'] === label)!
    .props.onCheckedChange?.(value)
}
const body = (patch: Partial<MailMessageDetail> = {}): MailMessageDetail => ({
  ...message(),
  to: [{ name: 'Reader', address: 'reader@example.test' }],
  body: 'Committed plaintext',
  html: '<p>Formatted <strong>body</strong></p>',
  truncated: false,
  ...patch,
})
const page = (patch: Partial<MailMessagePage> = {}): MailMessagePage => ({
  items: [message(), message({ id: 'message-2', subject: 'Second subject' })],
  nextCursor: 'opaque-page-2',
  total: 25,
  unread: 12,
  ...patch,
})

beforeEach(() => {
  lifecycles = []
  vi.mocked(listMessages).mockReset().mockResolvedValue(page())
  vi.mocked(getMessage)
    .mockReset()
    .mockImplementation(async (input) => body({ id: input.messageId }))
  vi.mocked(setMessagesRead)
    .mockReset()
    .mockImplementation(async (input) => ({
      updatedIds: input.messageIds,
      failures: [],
      isRead: input.isRead,
    }))
  vi.mocked(copyText).mockReset().mockResolvedValue(true)
})
afterEach(() => {
  for (const hooks of lifecycles) hooks.dispose()
  context.hooks = null
  vi.useRealTimers()
})
async function openReader() {
  const close = vi.fn()
  const changed = vi.fn()
  const view = mount(
    MailReader({ account: mailbox(), onClose: close, onChanged: changed }),
  )
  await flushPromises()
  return { ...view, close, changed }
}

describe('mailbox reader interactions', () => {
  it('shows explicit unread indicators, folder counts, filters and independent checkbox selection', async () => {
    const view = await openReader()
    expect(text(view.tree())).toContain('共 25 封')
    expect(text(view.tree())).toContain('未读 12')
    expect(text(view.tree())).toContain('未读')
    check(view.tree(), '选择邮件 Synthetic subject', true)
    expect(text(view.tree())).toContain('已选 1')
    expect(getMessage).not.toHaveBeenCalled()
    check(view.tree(), '全选当前页邮件', true)
    expect(text(view.tree())).toContain('已选 2')
    components(view.tree(), Tabs)
      .find((node) => node.props.value === 'all')!
      .props.onValueChange?.('unread')
    await flushPromises()
    expect(listMessages).toHaveBeenLastCalledWith({
      accountId: 'mailbox-1',
      expectedEmail: 'reader@example.test',
      folder: 'inbox',
      readState: 'unread',
    })
    expect(text(view.tree())).toContain('已选 0')
  })

  it('marks selected/current-page read and unread, retaining failed selections with a fixed error', async () => {
    const view = await openReader()
    check(view.tree(), '全选当前页邮件', true)
    vi.mocked(setMessagesRead).mockResolvedValueOnce({
      updatedIds: ['message-1'],
      failures: [{ messageId: 'message-2', code: 'PERMISSION_DENIED' }],
      isRead: true,
    })
    click(view.tree(), '所选标为已读')
    await flushPromises()
    expect(text(view.tree())).toContain('已选 1')
    expect(text(view.tree())).toContain('1 封未更新')
    expect(text(view.tree())).toContain('修改已读状态')
    click(view.tree(), '本页标为未读')
    await flushPromises()
    expect(setMessagesRead).toHaveBeenLastCalledWith({
      accountId: 'mailbox-1',
      expectedEmail: 'reader@example.test',
      folder: 'inbox',
      messageIds: ['message-1', 'message-2'],
      isRead: false,
    })
  })

  it('keeps a readable selected detail when automatic read is denied or its unread row disappears', async () => {
    const view = await openReader()
    components(view.tree(), Tabs)
      .find((node) => node.props.value === 'all')!
      .props.onValueChange?.('unread')
    await flushPromises()
    vi.mocked(setMessagesRead).mockRejectedValueOnce(
      new EmailRequestError('PERMISSION_DENIED'),
    )
    click(view.tree(), '打开邮件 Synthetic subject')
    await flushPromises()
    const detail = mount(detailElement(view.tree()))
    expect(text(detail.tree())).toContain('未读')
    expect(text(view.tree())).toContain('修改已读状态')
    click(view.tree(), '所选标为已读')
    expect(setMessagesRead).toHaveBeenCalledTimes(1)
    click(detail.tree(), '标为已读')
    await flushPromises()
    const selected = mount(detailElement(view.tree()))
    components(selected.tree(), Tabs)[0]!.props.onValueChange?.('text')
    expect(text(selected.tree())).toContain('Committed plaintext')
    expect(view.changed).toHaveBeenCalledOnce()
  })

  it('uses cursors in both directions and clears detail on explicit folder/page/filter navigation', async () => {
    const view = await openReader()
    click(view.tree(), '打开邮件 Synthetic subject')
    await flushPromises()
    click(view.tree(), '下一页邮件')
    await flushPromises()
    expect(listMessages).toHaveBeenLastCalledWith({
      accountId: 'mailbox-1',
      expectedEmail: 'reader@example.test',
      folder: 'inbox',
      readState: 'all',
      cursor: 'opaque-page-2',
    })
    expect(detailElement(view.tree())).toBeUndefined()
    click(view.tree(), '上一页邮件')
    await flushPromises()
    click(view.tree(), '下一页邮件')
    await flushPromises()
    expect(text(view.tree())).toContain('第 2 页')
    components(view.tree(), Tabs)
      .find((node) => node.props.value === 'inbox')!
      .props.onValueChange?.('junkemail')
    await flushPromises()
    expect(listMessages).toHaveBeenLastCalledWith({
      accountId: 'mailbox-1',
      expectedEmail: 'reader@example.test',
      folder: 'junkemail',
      readState: 'all',
    })
    expect(text(view.tree())).toContain('第 1 页')
  })

  it('retains selected detail and page during polling and keeps committed data after failed refresh', async () => {
    vi.useFakeTimers()
    const view = await openReader()
    click(view.tree(), '打开邮件 Synthetic subject')
    await flushPromises()
    check(view.tree(), '选择邮件 Second subject', true)
    vi.mocked(listMessages).mockRejectedValueOnce(
      new Error('refresh_token=synthetic-secret'),
    )
    await vi.advanceTimersByTimeAsync(5_000)
    expect(detailElement(view.tree()).props.state).toMatchObject({
      detail: { body: 'Committed plaintext' },
    })
    expect(text(view.tree())).toContain('Second subject')
    expect(text(view.tree())).toContain('已选 1')
    expect(text(view.tree())).toContain('读取失败')
    expect(text(view.tree())).not.toContain('synthetic-secret')
  })

  it('blocks late detail load and automatic writes immediately when the dialog closes', async () => {
    const pending = deferred<MailMessageDetail>()
    vi.mocked(getMessage).mockReturnValueOnce(pending.promise)
    const view = await openReader()
    click(view.tree(), '打开邮件 Synthetic subject')
    components(view.tree(), Dialog)[0]!.props.onOpenChange?.(false)
    pending.resolve(body())
    await flushPromises()
    expect(view.close).toHaveBeenCalledOnce()
    expect(setMessagesRead).not.toHaveBeenCalled()
  })

  it('invalidates old bulk handlers when the folder changes before another render', async () => {
    const view = await openReader()
    check(view.tree(), '全选当前页邮件', true)
    const previous = view.tree()
    components(previous, Tabs)
      .find((node) => node.props.value === 'inbox')!
      .props.onValueChange?.('junkemail')
    click(previous, '所选标为已读')
    click(previous, '本页标为未读')
    await flushPromises()
    expect(setMessagesRead).not.toHaveBeenCalled()
  })

  it('ignores a detail action from the previously selected message', async () => {
    const view = await openReader()
    click(view.tree(), '打开邮件 Synthetic subject')
    await flushPromises()
    const previous = mount(detailElement(view.tree()))
    vi.mocked(setMessagesRead).mockClear()
    const next = deferred<MailMessageDetail>()
    vi.mocked(getMessage).mockReturnValueOnce(next.promise)
    click(view.tree(), '打开邮件 Second subject')
    click(previous.tree(), '标为未读')
    expect(setMessagesRead).not.toHaveBeenCalled()
    next.resolve(body({ id: 'message-2', isRead: true }))
    await flushPromises()
  })

  it('keys account/email/transport identity changes without resetting on reception timestamps', () => {
    const original = MailReader({ account: mailbox(), onClose: () => {} })
    const changed = MailReader({
      account: mailbox({ email: 'changed@example.test' }),
      onClose: () => {},
    })
    const polled = MailReader({
      account: mailbox({ updatedAt: '2026-11-12T12:02:00Z' }),
      onClose: () => {},
    })
    expect(changed.key).not.toBe(original.key)
    expect(polled.key).toBe(original.key)
  })

  it('renders HTML only in a network-blocked sandbox, exposes plaintext and copies only explicit body text', async () => {
    const view = await openReader()
    click(view.tree(), '打开邮件 Synthetic subject')
    await flushPromises()
    const selected = mount(detailElement(view.tree()))
    const frame = elements(selected.tree()).find((node) => node.type === 'iframe')!
    expect(frame.props.sandbox).toBe('')
    expect(frame.props.referrerPolicy).toBe('no-referrer')
    expect(frame.props.src).toBeUndefined()
    expect(frame.props.srcDoc).toContain("default-src 'none'")
    expect(frame.props.srcDoc).toContain("form-action 'none'")
    expect(frame.props.srcDoc).toContain('<strong>body</strong>')
    components(selected.tree(), Tabs)[0]!.props.onValueChange?.('text')
    expect(elements(selected.tree()).some((node) => node.type === 'iframe')).toBe(false)
    expect(text(selected.tree())).toContain('Committed plaintext')
    click(selected.tree(), '复制正文')
    await flushPromises()
    expect(copyText).toHaveBeenCalledExactlyOnceWith('Committed plaintext')
    expect(text(selected.tree())).toContain('已复制')
  })

  it('escapes plaintext markup and gives visible copy failure without exposing provider content', async () => {
    vi.mocked(getMessage).mockResolvedValueOnce(
      body({ body: '<img src=x onerror=alert(1)>', html: null }),
    )
    vi.mocked(copyText).mockResolvedValueOnce(false)
    const view = await openReader()
    click(view.tree(), '打开邮件 Synthetic subject')
    await flushPromises()
    const selected = mount(detailElement(view.tree()))
    expect(renderToStaticMarkup(selected.tree())).toContain(
      '&lt;img src=x onerror=alert(1)&gt;',
    )
    click(selected.tree(), '复制正文')
    await flushPromises()
    expect(text(selected.tree())).toContain('复制失败')
  })

  it('rebuilds formatted HTML from inert tags with no provider attributes, links or resource elements', () => {
    const document = mailHtmlDocument(
      '<meta http-equiv="refresh" content="0;url=https://tracker.test"><base href="https://tracker.test">' +
        '<style>p{background:url(https://tracker.test)}</style><script>alert(1)</script>' +
        '<form action="https://tracker.test"><input autofocus></form>' +
        '<svg><a xlink:href="https://tracker.test">SVG</a></svg><iframe src="https://tracker.test"></iframe>' +
        '<img src="https://tracker.test/pixel"><a href="https://tracker.test" target="_top">Link</a>' +
        '<p onclick="alert(1)" style="background:url(https://tracker.test)">Hello <strong>world</strong></p>',
    )
    const content = document.slice(document.indexOf('<body>'))
    expect(content).toContain('<p>Hello <strong>world</strong></p>')
    expect(content).not.toMatch(
      /<(?:a|img|svg|script|style|iframe|meta|base|form|input)\b/i,
    )
    expect(content).not.toMatch(/(?:src|href|onclick|style|target)\s*=/i)
    expect(document).toContain("connect-src 'none'")
    expect(document).toContain("script-src 'none'")
    expect(document).not.toContain('navigate-to')
  })
})
