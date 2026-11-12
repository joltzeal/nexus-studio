import { listPlugins, type PluginView } from '@/lib/platform/native-plugins'
import {
  assignAccountMailbox,
  listAccountMailboxTargets,
} from '@/features/accounts/account-mailbox-api'
import type { AssignedAccountMailbox } from '@/features/accounts/types'
import { getMailbox, listMailboxTargets } from './api'
import type { MailboxView } from './types'

const EMAIL = {
  id: 'studio.email',
  capability: 'email.provider',
  methods: ['email.accounts.get', 'email.accounts.targets'],
}
const ACCOUNTS = {
  id: 'studio.vinted-accounts',
  capability: 'account.pool',
  methods: ['vinted.accounts.mailbox.targets', 'vinted.accounts.mailbox.set'],
}
type Requirement = typeof EMAIL
type TargetQuery = { query: string; page: number }

class LinkFailure extends Error {}

function identity(plugin: PluginView): string {
  return JSON.stringify([
    plugin.id,
    plugin.version,
    plugin.source,
    plugin.status?.pid ?? null,
    plugin.status?.startedAt ?? null,
  ])
}

async function scope(requirements: Requirement[]): Promise<string> {
  const plugins = await listPlugins()
  return JSON.stringify(
    requirements.map((requirement) => {
      const plugin = plugins.find((item) => item.id === requirement.id)
      if (
        !plugin ||
        !plugin.enabled ||
        plugin.state !== 'running' ||
        !plugin.capabilities.includes(requirement.capability) ||
        !plugin.granted.includes(requirement.capability) ||
        !requirement.methods.every((method) => plugin.methods.includes(method))
      ) {
        throw new LinkFailure(
          requirement.id === EMAIL.id
            ? '请启用并更新邮箱插件后重试。'
            : '请启用并更新 Vinted 账号池插件后重试。',
        )
      }
      return identity(plugin)
    }),
  )
}

async function unchanged(
  requirements: Requirement[],
  expected: string,
  written = false,
): Promise<void> {
  let current: string | null = null
  try {
    current = await scope(requirements)
  } catch {
    // A stopped process is a changed scope, even when its last PID is retained.
  }
  if (current !== expected) {
    throw new LinkFailure(
      written
        ? '插件状态已变化，请刷新核对关联结果。'
        : '插件状态已变化，请重新打开后重试。',
    )
  }
}

async function controlled<T>(action: () => Promise<T>, failure: string): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof LinkFailure) throw error
    // eslint-disable-next-line preserve-caught-error -- Plugin rejections may contain credentials.
    throw new Error(failure)
  }
}

function matches(
  current: Pick<MailboxView, 'id' | 'email'>,
  expected: Pick<MailboxView, 'id' | 'email'>,
): void {
  if (
    current.id !== expected.id ||
    current.email.trim().toLowerCase() !== expected.email.trim().toLowerCase()
  ) {
    throw new LinkFailure('邮箱资料已变化，请重新选择并关联邮箱。')
  }
}

export function loadAccountLinkTargets(input: TargetQuery) {
  return controlled(async () => {
    const expected = await scope([ACCOUNTS])
    const result = await listAccountMailboxTargets({ ...input, pageSize: 10 })
    await unchanged([ACCOUNTS], expected)
    return result
  }, '账号池读取失败，请刷新后重试。')
}

export function loadMailboxLinkTargets(input: TargetQuery) {
  return controlled(async () => {
    const expected = await scope([EMAIL])
    const result = await listMailboxTargets({ ...input, pageSize: 10 })
    await unchanged([EMAIL], expected)
    return result
  }, '邮箱列表读取失败，请确认邮箱插件可用后重试。')
}

export function linkMailboxToAccount(
  accountId: string,
  mailbox: Pick<MailboxView, 'id' | 'email'>,
  expectedMailboxId: string | null,
) {
  return controlled(async () => {
    const requirements = [EMAIL, ACCOUNTS]
    const expected = await scope(requirements)
    const current = await getMailbox(mailbox.id)
    matches(current, mailbox)
    await unchanged(requirements, expected)
    const result = await assignAccountMailbox(
      accountId,
      { pluginId: 'studio.email', mailboxId: current.id, email: current.email },
      expectedMailboxId,
    )
    await unchanged(requirements, expected, true)
    return result
  }, '邮箱关联失败，资料可能已变化，请刷新账号与邮箱后重试。')
}

export function unlinkMailboxFromAccount(accountId: string, expectedMailboxId: string) {
  return controlled(async () => {
    const expected = await scope([ACCOUNTS])
    const result = await assignAccountMailbox(accountId, null, expectedMailboxId)
    await unchanged([ACCOUNTS], expected, true)
    return result
  }, '解除邮箱关联失败，请刷新账号资料后重试。')
}

export function resolveLinkedMailbox(link: AssignedAccountMailbox) {
  return controlled(async () => {
    const expected = await scope([EMAIL])
    const result = await getMailbox(link.mailboxId)
    matches(result, { id: link.mailboxId, email: link.email })
    if (!result.enabled) throw new LinkFailure('此邮箱已暂停，请先在邮箱管理中启用。')
    await unchanged([EMAIL], expected)
    return result
  }, '关联邮箱已删除或暂不可用，请重新选择邮箱。')
}
