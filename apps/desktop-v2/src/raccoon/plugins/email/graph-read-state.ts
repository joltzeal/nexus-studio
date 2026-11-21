import type { MailboxView, MailFolder, MailFolderCounts, MailMessage } from './model.ts'

type MailboxIdentity = Pick<MailboxView, 'id' | 'email'>

function storageKey(mailbox: MailboxIdentity, folder: MailFolder) {
  return `raccoon:email:graph-read:v1:${JSON.stringify([mailbox.id, mailbox.email.toLowerCase(), folder])}`
}

export function graphReadMarks(mailbox: MailboxIdentity, folder: MailFolder) {
  const marks = new Map<string, boolean>()
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(storageKey(mailbox, folder)) ?? '[]',
    )
    if (!Array.isArray(stored)) return marks
    for (const entry of stored) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        entry[0].length > 0 &&
        entry[0].length <= 2048 &&
        typeof entry[1] === 'boolean'
      )
        marks.set(entry[0], entry[1])
    }
  } catch {
    return marks
  }
  return marks
}

function writeMarks(
  mailbox: MailboxIdentity,
  folder: MailFolder,
  marks: ReadonlyMap<string, boolean>,
) {
  const key = storageKey(mailbox, folder)
  if (marks.size) localStorage.setItem(key, JSON.stringify([...marks]))
  else localStorage.removeItem(key)
}

export function markGraphMessages(
  mailbox: MailboxIdentity,
  folder: MailFolder,
  messages: MailMessage[],
  isRead: boolean,
) {
  const marks = graphReadMarks(mailbox, folder)
  let changed = false
  for (const message of messages) {
    if (message.isRead === isRead) {
      changed = marks.delete(message.id) || changed
    } else if (marks.get(message.id) !== isRead) {
      marks.set(message.id, isRead)
      changed = true
    }
  }
  if (changed) writeMarks(mailbox, folder, marks)
  return marks
}

export function reconcileGraphMarks(
  mailbox: MailboxIdentity,
  folder: MailFolder,
  marks: Map<string, boolean>,
  messages: MailMessage[],
  completeFolder: boolean,
) {
  const observed = new Map(messages.map((message) => [message.id, message.isRead]))
  const previousSize = marks.size
  for (const [id, isRead] of marks) {
    if (observed.get(id) === isRead || (completeFolder && !observed.has(id)))
      marks.delete(id)
  }
  if (marks.size !== previousSize) {
    try {
      writeMarks(mailbox, folder, marks)
    } catch {
      return marks
    }
  }
  return marks
}

export function graphUnreadCount(
  counts: MailFolderCounts | null,
  marks: ReadonlyMap<string, boolean>,
) {
  if (!counts) return null
  let unread = counts.unread
  for (const isRead of marks.values()) unread += isRead ? -1 : 1
  return Math.max(0, Math.min(counts.total, unread))
}

export function mailboxUnread(mailbox: MailboxView, folder: MailFolder) {
  const counts = mailbox.reception[folder]
  return mailbox.transport === 'graph' && counts
    ? graphUnreadCount(counts, graphReadMarks(mailbox, folder))
    : counts?.unread
}
