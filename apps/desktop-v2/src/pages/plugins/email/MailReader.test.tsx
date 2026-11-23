import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emailApi } from '../../../raccoon/plugins/email/api'
import { graphReadMarks, markGraphMessages } from '../../../raccoon/plugins/email/graph-read-state'
import { markAllMailboxRead } from '../../../raccoon/plugins/email/mark-all-read'
import type {
  MailboxView,
  MailMessage,
  MailMessageDetail,
} from '../../../raccoon/plugins/email/model'
import { MailReader } from './MailReader'

vi.mock('../../../raccoon/plugins/email/api', () => ({
  emailApi: { listMessages: vi.fn(), getMessage: vi.fn(), setMessagesRead: vi.fn() },
}))

const mailbox: MailboxView = {
  id: 'mailbox',
  email: 'reader@example.test',
  provider: 'microsoft',
  transport: 'graph',
  clientId: 'client',
  note: '',
  enabled: true,
  status: 'active',
  hasPassword: false,
  hasRefreshToken: true,
  refreshing: false,
  receiving: false,
  reception: {
    lastCheckedAt: null,
    nextCheckAt: null,
    latestReceivedAt: null,
    lastError: null,
    lastErrorCode: null,
    inbox: { total: 1, unread: 1 },
    junkemail: null,
  },
  accessExpiresAt: null,
  lastAttemptAt: null,
  lastRefreshedAt: null,
  lastRotatedAt: null,
  nextRefreshAt: null,
  lastError: null,
  lastErrorCode: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const message: MailMessage = {
  id: 'message',
  subject: '测试邮件',
  from: { name: 'Sender', address: 'sender@example.test' },
  receivedAt: null,
  isRead: false,
  hasAttachments: false,
  preview: '',
}

const detail: MailMessageDetail = {
  ...message,
  to: [],
  body: '纯文本正文',
  html: '<h2>邮件标题</h2><p onclick="blocked" style="color:red"><strong>A &amp; B</strong><br><a href="https://tracker.test">链接文字</a></p><ul><li>第一项</li></ul><table><tr><td>表格内容</td></tr></table>',
  truncated: false,
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.mocked(emailApi.listMessages).mockResolvedValue({
    items: [message],
    total: 1,
    unread: 1,
    nextCursor: null,
  })
  vi.mocked(emailApi.getMessage).mockResolvedValue(detail)
  vi.mocked(emailApi.setMessagesRead).mockResolvedValue({
    updatedIds: [message.id],
    failures: [],
    isRead: true,
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function renderReader(account = mailbox) {
  await act(async () => root.render(<MailReader mailbox={account} onClose={vi.fn()} />))
}

async function clickButton(label: string) {
  const button = [...document.body.querySelectorAll('button')].find((item) =>
    item.textContent?.trim().startsWith(label),
  )
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

async function selectOption(label: string, option: string) {
  const field = [...document.querySelectorAll<HTMLElement>('[role="combobox"]')].find(
    (item) =>
      document.getElementById(item.getAttribute('aria-labelledby') ?? '')?.textContent ===
      label,
  )
  expect(field).toBeDefined()
  await act(async () => field!.click())
  const choice = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent?.trim().startsWith(option),
  )
  expect(choice).toBeDefined()
  await act(async () => choice!.click())
}

it('renders themed HTML elements in the reader and removes active content', async () => {
  vi.mocked(emailApi.getMessage).mockResolvedValue({
    ...detail,
    html: `${detail.html}<p style="background: url(https://tracker.test); border: 1px solid #abc; padding: 10px 20px">样式边界</p><style>blocked</style><script>blocked</script><img src="https://tracker.test"><iframe src="https://tracker.test"></iframe>`,
  })
  await renderReader()
  await clickButton(message.subject)

  const body = document.querySelector('[role="region"][aria-label="邮件正文"]')
  expect(body?.querySelector('h2')?.textContent).toBe('邮件标题')
  expect(body?.querySelector('p strong')?.textContent).toBe('A & B')
  expect(body?.querySelector('p br')).not.toBeNull()
  expect(body?.querySelector('ul li')?.textContent).toBe('第一项')
  expect(body?.querySelector('table td')?.textContent).toBe('表格内容')
  expect(body?.textContent).toContain('链接文字')
  expect(body?.textContent).not.toContain('blocked')
  expect(body?.querySelector('p')?.getAttribute('style')).toBe('color: red;')
  expect(body?.querySelectorAll('p')[1]?.style.padding).toBe('10px 20px')
  expect(body?.querySelectorAll('p')[1]?.style.background).toBe('')
  expect(
    body?.querySelector('a, iframe, img, script, style, [onclick], [href], [src]'),
  ).toBeNull()
  expect(document.querySelector('iframe')).toBeNull()

  await clickButton('查看纯文本')
  expect(document.querySelector('textarea')?.value).toBe(detail.body)
})

it('marks messages based on their effective Graph state without writing to Outlook', async () => {
  const locallyRead = { ...message, id: 'locally-read' }
  const locallyUnread = { ...message, id: 'locally-unread', isRead: true }
  markGraphMessages(mailbox, 'inbox', [locallyRead], true)
  markGraphMessages(mailbox, 'inbox', [locallyUnread], false)
  vi.mocked(emailApi.listMessages)
    .mockResolvedValueOnce({ items: [locallyRead], total: 3, unread: 2, nextCursor: 'next' })
    .mockResolvedValueOnce({ items: [locallyUnread, message], total: 3, unread: 2, nextCursor: null })
    .mockResolvedValueOnce({ items: [], total: 0, unread: 0, nextCursor: null })

  await expect(markAllMailboxRead(mailbox, emailApi, () => true)).resolves.toEqual({ updated: 2, failed: 0, incomplete: [] })
  expect(graphReadMarks(mailbox, 'inbox')).toEqual(new Map([[locallyRead.id, true], [message.id, true]]))
  expect(emailApi.setMessagesRead).not.toHaveBeenCalled()
})

it('reports confirmed IMAP writes and incomplete pagination separately', async () => {
  const imap = { ...mailbox, transport: 'imap' } as const
  const failed = { ...message, id: 'second' }
  vi.mocked(emailApi.listMessages)
    .mockResolvedValueOnce({ items: [message, failed], total: 2, unread: 2, nextCursor: 'next' })
    .mockResolvedValueOnce({ items: [message], total: 2, unread: 2, nextCursor: 'next' })
    .mockResolvedValueOnce({ items: [], total: 0, unread: 0, nextCursor: null })
  vi.mocked(emailApi.setMessagesRead).mockResolvedValueOnce({
    updatedIds: [message.id], failures: [{ messageId: failed.id, code: 'TIMEOUT' }], isRead: true,
  })

  await expect(markAllMailboxRead(imap, emailApi, () => true)).resolves.toEqual({
    updated: 1, failed: 1, incomplete: ['收件箱 · 邮箱服务返回了重复分页位置'],
  })
  expect(emailApi.setMessagesRead).toHaveBeenCalledOnce()
})

it('falls back to plain text when the provider has no HTML', async () => {
  vi.mocked(emailApi.getMessage).mockResolvedValue({ ...detail, html: null })
  await renderReader()
  await clickButton(message.subject)
  expect(document.querySelector('textarea')?.value).toBe(detail.body)
  expect(document.body.textContent).not.toContain('查看纯文本')
})

it('marks mail read only after opening its detail and updates the count after confirmation', async () => {
  let resolveDetail!: (value: MailMessageDetail) => void
  let confirmRead!: () => void
  vi.mocked(emailApi.getMessage).mockReturnValue(
    new Promise((resolve) => {
      resolveDetail = resolve
    }),
  )
  vi.mocked(emailApi.setMessagesRead).mockReturnValue(
    new Promise((resolve) => {
      confirmRead = () =>
        resolve({ updatedIds: [message.id], failures: [], isRead: true })
    }),
  )
  await renderReader({ ...mailbox, transport: 'imap' })
  expect(emailApi.setMessagesRead).not.toHaveBeenCalled()
  await clickButton(message.subject)
  expect(emailApi.setMessagesRead).not.toHaveBeenCalled()
  await act(async () => resolveDetail(detail))

  expect(emailApi.setMessagesRead).toHaveBeenCalledExactlyOnceWith({
    accountId: mailbox.id,
    expectedEmail: mailbox.email,
    folder: 'inbox',
    messageIds: [message.id],
    isRead: true,
  })
  expect(document.body.textContent).toContain('未读 1')
  expect(document.querySelector('article h2')?.textContent).toBe(message.subject)
  await act(async () => confirmRead())
  expect(document.body.textContent).toContain('未读 0')
})

it('syncs the unread count when the opened detail is already read', async () => {
  vi.mocked(emailApi.getMessage).mockResolvedValue({ ...detail, isRead: true })
  await renderReader()
  await clickButton(message.subject)

  expect(emailApi.setMessagesRead).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('未读 0')
})

it('keeps Graph marks on this device across reopening and never asks Graph to write', async () => {
  vi.mocked(emailApi.setMessagesRead).mockRejectedValue(new Error('read-only'))
  await renderReader()
  await clickButton(message.subject)

  expect(emailApi.setMessagesRead).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('未读 0')
  expect(document.body.textContent).not.toContain('未能标记已读')
  expect(document.querySelector('article h2')?.textContent).toBe(message.subject)

  await act(async () => root.render(null))
  await renderReader()
  expect(document.body.textContent).toContain('未读 0')
  await clickButton('选择')
  await clickButton('标记未读')
  expect(document.body.textContent).toContain('未读 1')
  await clickButton('选择')
  await clickButton('标记已读')
  expect(document.body.textContent).toContain('未读 0')
  expect(emailApi.setMessagesRead).not.toHaveBeenCalled()

  await act(async () => root.render(null))
  await renderReader({ ...mailbox, id: 'other-mailbox' })
  expect(document.body.textContent).toContain('未读 1')
})

it('filters Graph pages using local state and isolates marks by folder', async () => {
  const another = { ...message, id: 'another-message', subject: '另一封邮件' }
  vi.mocked(emailApi.listMessages).mockImplementation(async (query) => ({
    items: query.folder === 'inbox' && !query.cursor ? [another] : [message],
    total: query.folder === 'inbox' ? 2 : 1,
    unread: query.folder === 'inbox' ? 2 : 1,
    nextCursor: query.folder === 'inbox' && !query.cursor ? 'next-page' : null,
  }))
  await renderReader()
  await clickButton('下一页')
  await clickButton(message.subject)
  await selectOption('已读状态', '已读')
  expect(document.body.textContent).toContain(message.subject)
  expect(document.body.textContent).not.toContain(another.subject)
  expect(emailApi.listMessages).toHaveBeenLastCalledWith({
    accountId: mailbox.id,
    expectedEmail: mailbox.email,
    folder: 'inbox',
    cursor: 'next-page',
    readState: undefined,
  })

  await selectOption('邮件目录', '垃圾箱')
  expect(document.body.textContent).not.toContain(message.subject)
  expect(document.body.textContent).toContain('未读 1')
  expect(emailApi.setMessagesRead).not.toHaveBeenCalled()
})

it('does not mark a message when the reader closes before the detail arrives', async () => {
  let resolveDetail!: (value: MailMessageDetail) => void
  vi.mocked(emailApi.getMessage).mockReturnValue(
    new Promise((resolve) => {
      resolveDetail = resolve
    }),
  )
  await renderReader()
  await clickButton(message.subject)
  await act(async () => root.render(null))
  await act(async () => resolveDetail(detail))
  expect(emailApi.setMessagesRead).not.toHaveBeenCalled()
  await renderReader()
  expect(document.body.textContent).toContain('未读 1')
})
