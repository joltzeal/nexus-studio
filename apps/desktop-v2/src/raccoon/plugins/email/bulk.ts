import type { MailboxIdentity } from './model.ts'
import type {
  AccountMailboxTarget,
  MailboxImportInput,
} from '../vinted-accounts/model.ts'
import { duplicateMailboxPreview } from '../vinted-accounts/mailbox-relations.ts'

export function validateMailboxSelection(mailboxes: MailboxIdentity[]) {
  if (!mailboxes.length || mailboxes.length > 100)
    throw new Error('每批请选择 1–100 个邮箱')
  if (
    new Set(mailboxes.map((item) => item.id)).size !== mailboxes.length ||
    new Set(mailboxes.map((item) => item.email.trim().toLowerCase())).size !==
      mailboxes.length
  )
    throw new Error('所选邮箱存在重复 UUID 或地址，请刷新后重新选择')
  if (mailboxes.some((item) => !item.enabled || item.email.length > 190))
    throw new Error('所选邮箱已暂停或地址超过账号池的 190 字符限制，请调整选择')
}

export async function readMailboxImportPreview(
  mailboxes: MailboxIdentity[],
  targets: (page: number) => Promise<{ items: AccountMailboxTarget[]; total: number }>,
  isCurrent: () => boolean = () => true,
) {
  validateMailboxSelection(mailboxes)
  const accounts: AccountMailboxTarget[] = []
  let total = 0
  for (let page = 1; page <= 40; page++) {
    if (!isCurrent()) throw new Error('页面或插件已变化，请重新打开后核对')
    const result = await targets(page)
    if (!isCurrent()) throw new Error('页面或插件已变化，请重新打开后核对')
    if (page === 1) total = result.total
    if (
      total !== result.total ||
      total > 2000 ||
      result.items.length > 50 ||
      (result.items.length === 0 && accounts.length < total)
    )
      throw new Error('账号池已变化，请重新读取重复检查')
    accounts.push(...result.items)
    if (
      new Set(accounts.map((item) => item.id)).size !== accounts.length ||
      accounts.length > total
    )
      throw new Error('账号池分页已变化，请重新读取重复检查')
    if (accounts.length === total)
      return duplicateMailboxPreview(
        mailboxes.map(({ id, email }) => ({ mailboxId: id, email })),
        accounts,
      )
  }
  throw new Error('账号池分页不完整，请刷新后重试')
}

export function mailboxImportInput(
  mailboxes: MailboxIdentity[],
  fields: Pick<MailboxImportInput, 'loginMethod' | 'status' | 'note'>,
  expectedDuplicateIds: string[],
): MailboxImportInput {
  validateMailboxSelection(mailboxes)
  return {
    mailboxes: mailboxes.map(({ id, email }) => ({ mailboxId: id, email })),
    loginMethod: fields.loginMethod,
    status: fields.status,
    note: fields.note.trim(),
    phone: '',
    smsOtpUrl: '',
    emailOtpUrl: '',
    homepageUrl: '',
    expectedDuplicateIds: [...expectedDuplicateIds],
  }
}

export async function readMailboxImportFile(file: Pick<File, 'name' | 'size' | 'text'>) {
  if (!/\.txt$/i.test(file.name) || file.size < 1 || file.size > 512 * 1024)
    throw new Error('请选择不超过 512 KiB 的 UTF-8 TXT 四段资料文件')
  const text = await file.text()
  if (new TextEncoder().encode(text).byteLength > 512 * 1024 || text.includes('\uFFFD'))
    throw new Error('文件不是有效的 UTF-8 四段资料，或超过 512 KiB')
  return text.replace(/^\uFEFF/u, '')
}
