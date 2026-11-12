import { callPlugin } from '@/lib/platform/native-plugins'
import {
  ACCOUNTS_CAPABILITY,
  ACCOUNTS_PLUGIN_ID,
  ACCOUNT_STATUSES,
  type AccountMailboxInput,
  type AccountMailboxSetResult,
  type AccountMailboxTarget,
  type AccountMailboxTargetList,
  type AccountMailboxTargetsInput,
  type AssignedAccountMailbox,
} from './types'

export type {
  AccountMailboxInput,
  AccountMailboxSetResult,
  AccountMailboxTarget,
  AccountMailboxTargetList,
  AccountMailboxTargetsInput,
  AssignedAccountMailbox,
} from './types'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function id(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 64 &&
    !/\s/.test(value) &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )
}

function integer(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  )
}

function mailboxInput(value: unknown): value is AccountMailboxInput {
  return (
    record(value) &&
    exactKeys(value, ['pluginId', 'mailboxId', 'email']) &&
    value.pluginId === 'studio.email' &&
    id(value.mailboxId) &&
    typeof value.email === 'string' &&
    value.email.length <= 254 &&
    /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+.-]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/.test(
      value.email,
    )
  )
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) ===
      value.slice(0, 10)
  )
}

export function assignedAccountMailbox(value: unknown): value is AssignedAccountMailbox {
  return (
    record(value) &&
    exactKeys(value, ['pluginId', 'mailboxId', 'email', 'linkedAt']) &&
    mailboxInput({
      pluginId: value.pluginId,
      mailboxId: value.mailboxId,
      email: value.email,
    }) &&
    timestamp(value.linkedAt)
  )
}

function target(value: unknown): value is AccountMailboxTarget {
  return (
    record(value) &&
    exactKeys(value, ['id', 'account', 'status', 'mailbox']) &&
    id(value.id) &&
    typeof value.account === 'string' &&
    value.account.trim().length > 0 &&
    value.account.length <= 190 &&
    ACCOUNT_STATUSES.some((status) => status === value.status) &&
    (value.mailbox === null || assignedAccountMailbox(value.mailbox))
  )
}

async function call(method: string, payload: unknown, failure: string): Promise<unknown> {
  try {
    return await callPlugin<unknown>(
      ACCOUNTS_PLUGIN_ID,
      ACCOUNTS_CAPABILITY,
      method,
      payload,
    )
  } catch {
    throw new Error(failure)
  }
}

export async function listAccountMailboxTargets(
  input: AccountMailboxTargetsInput = {},
): Promise<AccountMailboxTargetList> {
  if (
    !record(input) ||
    !Object.keys(input).every((key) => ['query', 'page', 'pageSize'].includes(key)) ||
    (input.query !== undefined &&
      (typeof input.query !== 'string' || input.query.trim().length > 200))
  ) {
    throw new Error('账号邮箱查询参数无效。')
  }
  const page = input.page === undefined ? 1 : input.page
  const pageSize = input.pageSize === undefined ? 20 : input.pageSize
  if (!integer(page, 1) || !integer(pageSize, 1, 50)) {
    throw new Error('账号邮箱查询参数无效。')
  }
  const result = await call(
    'vinted.accounts.mailbox.targets',
    input,
    '账号邮箱列表读取失败，请刷新后重试。',
  )
  if (
    !record(result) ||
    !exactKeys(result, ['items', 'total', 'page', 'pageSize', 'storageDurable']) ||
    result.page !== page ||
    result.pageSize !== pageSize ||
    !integer(result.total, 0, 2000) ||
    typeof result.storageDurable !== 'boolean' ||
    !Array.isArray(result.items) ||
    !result.items.every(target) ||
    result.items.length !==
      Math.min(pageSize, Math.max(0, result.total - (page - 1) * pageSize)) ||
    new Set(result.items.map((item) => item.id)).size !== result.items.length
  ) {
    throw new Error('账号邮箱返回的数据格式无效，请刷新后重试。')
  }
  return result as unknown as AccountMailboxTargetList
}

export async function assignAccountMailbox(
  accountId: string,
  mailbox: AccountMailboxInput | null,
  expectedMailboxId: string | null,
): Promise<AccountMailboxSetResult> {
  if (
    !id(accountId) ||
    !(expectedMailboxId === null || id(expectedMailboxId)) ||
    !(mailbox === null || record(mailbox))
  ) {
    throw new Error('账号邮箱关联参数无效，请刷新后重试。')
  }
  // Callers may hold a full view; send only the three identity fields.
  const reference =
    mailbox === null
      ? null
      : { pluginId: mailbox.pluginId, mailboxId: mailbox.mailboxId, email: mailbox.email }
  if (reference !== null && !mailboxInput(reference)) {
    throw new Error('账号邮箱关联参数无效，请刷新后重试。')
  }
  const result = await call(
    'vinted.accounts.mailbox.set',
    { accountId, mailbox: reference, expectedMailboxId },
    '账号邮箱关联未能保存，请刷新后重试。',
  )
  if (
    !record(result) ||
    !exactKeys(result, ['mailbox', 'updatedAt', 'storageDurable']) ||
    !(result.mailbox === null || assignedAccountMailbox(result.mailbox)) ||
    (result.mailbox?.mailboxId ?? null) !== (reference?.mailboxId ?? null) ||
    (result.mailbox?.email ?? null) !== (reference?.email ?? null) ||
    !timestamp(result.updatedAt) ||
    typeof result.storageDurable !== 'boolean'
  ) {
    throw new Error('账号邮箱返回的数据格式无效，请刷新后重试。')
  }
  return result as unknown as AccountMailboxSetResult
}
