import type { emailApi } from './api.ts'
import { graphReadMarks, markGraphMessages } from './graph-read-state.ts'
import type { MailboxView } from './model.ts'

const folders = { inbox: '收件箱', junkemail: '垃圾箱' } as const

export async function markAllMailboxRead(
  mailbox: MailboxView,
  api: Pick<typeof emailApi, 'listMessages' | 'setMessagesRead'>,
  current: () => boolean,
) {
  const result = { updated: 0, failed: 0, incomplete: [] as string[] }
  for (const folder of ['inbox', 'junkemail'] as const) {
    const scope = { accountId: mailbox.id, expectedEmail: mailbox.email, folder }
    const cursors = new Set<string>()
    const seen = new Set<string>()
    let cursor: string | undefined
    try {
      do {
        if (!current()) return null
        const page = await api.listMessages({ ...scope, ...(cursor ? { cursor } : {}) })
        if (!current()) return null
        const marks = mailbox.transport === 'graph' ? graphReadMarks(mailbox, folder) : null
        const unread = page.items.filter((message) => {
          if (seen.has(message.id)) return false
          seen.add(message.id)
          return !(marks?.get(message.id) ?? message.isRead)
        })
        if (marks) {
          if (unread.length) markGraphMessages(mailbox, folder, unread, true)
          result.updated += unread.length
        } else {
          for (let start = 0; start < unread.length; start += 20) {
            if (!current()) return null
            const batch = await api.setMessagesRead({
              ...scope,
              messageIds: unread.slice(start, start + 20).map((message) => message.id),
              isRead: true,
            })
            result.updated += batch.updatedIds.length
            result.failed += batch.failures.length
          }
        }
        cursor = page.nextCursor ?? undefined
        if (cursor) {
          if (cursors.has(cursor)) throw new Error('邮箱服务返回了重复分页位置')
          cursors.add(cursor)
        }
      } while (cursor)
    } catch (cause) {
      if (!current()) return null
      const message = cause instanceof Error ? cause.message : '结果未确认'
      result.incomplete.push(`${folders[folder]} · ${message}`)
    }
  }
  return current() ? result : null
}
