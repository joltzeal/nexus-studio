import type {
  AccountMailboxTarget,
  AssignedMailbox,
  MailboxImportInput,
} from './model.ts'

type MailboxIdentity = { id: string; email: string; enabled: boolean }
type RelationApi = {
  assignMailbox: (
    accountId: string,
    mailbox: Omit<AssignedMailbox, 'linkedAt'> | null,
    expectedMailboxId: string | null,
  ) => Promise<unknown>
  importMailboxes: (input: MailboxImportInput) => Promise<unknown>
}

export function duplicateAccountIds(
  mailboxes: MailboxImportInput['mailboxes'],
  accounts: {
    id: string
    account: string
    mailbox?: Pick<AssignedMailbox, 'mailboxId' | 'email'> | null
  }[],
) {
  return duplicateMailboxPreview(mailboxes, accounts).expectedDuplicateIds
}

export function duplicateMailboxPreview(
  mailboxes: MailboxImportInput['mailboxes'],
  accounts: {
    id: string
    account: string
    mailbox?: Pick<AssignedMailbox, 'mailboxId' | 'email'> | null
  }[],
) {
  const normalize = (value: string) => value.trim().toLowerCase()
  const duplicates = mailboxes
    .map((mailbox) => ({
      mailbox,
      accounts: accounts.filter(
        (account) =>
          normalize(account.account) === normalize(mailbox.email) ||
          account.mailbox?.mailboxId === mailbox.mailboxId ||
          (account.mailbox != null &&
            normalize(account.mailbox.email) === normalize(mailbox.email)),
      ),
    }))
    .filter((item) => item.accounts.length > 0)
  return {
    duplicates,
    skipped: duplicates.length,
    expectedDuplicateIds: [
      ...new Set(
        duplicates.flatMap((item) => item.accounts.map((account) => account.id)),
      ),
    ].sort(),
  }
}

export function createMailboxRelations(
  accounts: RelationApi,
  email: { getMailbox: (id: string) => Promise<MailboxIdentity> },
) {
  async function verify(identity: { mailboxId: string; email: string }) {
    const current = await email.getMailbox(identity.mailboxId)
    if (
      current.id !== identity.mailboxId ||
      current.email.trim().toLowerCase() !== identity.email.trim().toLowerCase() ||
      !current.enabled
    )
      throw new Error('邮箱已变化、暂停或删除，请刷新选择后重试。')
  }
  return {
    async link(
      account: AccountMailboxTarget,
      mailbox: MailboxIdentity | null,
      isCurrent: () => boolean = () => true,
    ) {
      const next = mailbox
        ? {
            pluginId: 'studio.email' as const,
            mailboxId: mailbox.id,
            email: mailbox.email,
          }
        : null
      if (next) await verify(next)
      if (!isCurrent()) throw new Error('页面已关闭或 Workspace 已切换，未写入关联。')
      return accounts.assignMailbox(account.id, next, account.mailbox?.mailboxId ?? null)
    },
    async import(input: MailboxImportInput, isCurrent: () => boolean = () => true) {
      for (const mailbox of input.mailboxes) {
        if (!isCurrent()) throw new Error('页面已关闭或 Workspace 已切换，未导入账号。')
        await verify(mailbox)
      }
      if (!isCurrent()) throw new Error('页面已关闭或 Workspace 已切换，未导入账号。')
      return accounts.importMailboxes(input)
    },
  }
}
