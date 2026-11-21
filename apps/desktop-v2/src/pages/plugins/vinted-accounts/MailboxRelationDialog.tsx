import { useEffect, useRef, useState } from 'react'
import { Alert, Button, DialogModal, Input } from '@proxyshard/shardx-ui-kit'
import { accountsApi } from '../../../raccoon/plugins/vinted-accounts/api'
import { emailApi } from '../../../raccoon/plugins/email/api'
import { createMailboxRelations } from '../../../raccoon/plugins/vinted-accounts/mailbox-relations'
import type { AccountMailboxTarget } from '../../../raccoon/plugins/vinted-accounts/model'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import { usePluginTask } from '../usePluginTask'

type MailboxIdentity = { id: string; email: string; enabled: boolean }
const relations = createMailboxRelations(accountsApi, emailApi)

export function MailboxRelationDialog({
  account,
  mailbox,
  onSaved,
  onClose,
}: {
  account?: AccountMailboxTarget
  mailbox?: MailboxIdentity
  onSaved: () => void
  onClose: () => void
}) {
  const emailPlugin = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === 'studio.email'),
  )
  const canChooseMailbox =
    !!emailPlugin &&
    emailPlugin.enabled &&
    emailPlugin.state === 'running' &&
    emailPlugin.capabilities.includes('email.provider') &&
    emailPlugin.granted.includes('email.provider') &&
    ['email.accounts.targets', 'email.accounts.get'].every((method) =>
      emailPlugin.methods.includes(method),
    )
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [mailboxes, setMailboxes] = useState<MailboxIdentity[]>([])
  const [accounts, setAccounts] = useState<AccountMailboxTarget[]>([])
  const [pending, setPending] = useState<{
    account: AccountMailboxTarget
    mailbox: MailboxIdentity | null
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const task = usePluginTask()
  const reads = useRef(0)
  useEffect(() => {
    const request = ++reads.current
    let live = true
    if (account && !canChooseMailbox) return
    setLoading(true)
    setError(null)
    const operation = account
      ? accountsApi.emailTargets(query, page, 20)
      : accountsApi.mailboxTargets(query, page, 20)
    void operation
      .then(
        (result) => {
          if (!live || request !== reads.current) return
          setTotal(result.total)
          if (account) setMailboxes(result.items as MailboxIdentity[])
          else setAccounts(result.items as AccountMailboxTarget[])
        },
        (cause) => {
          if (live && request === reads.current)
            setError(cause instanceof Error ? cause.message : '关系列表读取失败')
        },
      )
      .finally(() => {
        if (live && request === reads.current) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [account, query, page, canChooseMailbox])
  async function save() {
    if (!pending || !task.acquire()) return
    const token = task.begin()
    setBusy(true)
    setError(null)
    try {
      await relations.link(pending.account, pending.mailbox, () => task.current(token))
      if (task.current(token)) {
        setSaved(true)
        setPending(null)
        if (account) onSaved()
        else {
          setPage(1)
          setQuery('')
          reads.current++
          const result = await accountsApi.mailboxTargets('', 1, 20)
          if (task.current(token)) {
            setAccounts(result.items)
            setTotal(result.total)
          }
        }
      }
    } catch (cause) {
      if (task.current(token))
        setError(
          cause instanceof Error ? cause.message : '邮箱关联失败，请重新核对后重试。',
        )
    } finally {
      task.release()
      if (task.current(token)) setBusy(false)
    }
  }
  return (
    <DialogModal
      open
      title={pending ? '确认邮箱关系' : account ? '选择关联邮箱' : '关联 Vinted 账号'}
      subtitle={account ? `账号：${account.account}` : `邮箱：${mailbox?.email ?? ''}`}
      size="lg"
      confirmLabel={pending ? (pending.mailbox ? '确认关联' : '确认解除') : '完成'}
      isLoading={busy}
      onConfirm={() => {
        if (pending) void save()
        else onClose()
      }}
      onCancel={() => {
        if (!busy) {
          if (pending) setPending(null)
          else onClose()
        }
      }}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <div className="flex flex-col gap-3 py-inset">
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        {saved && (
          <Alert status="success" variant="lighter">
            邮箱关系已保存。
          </Alert>
        )}
        {pending ? (
          <>
            <p className="m-0 text-secondary text-text-sub-600">
              {pending.account.account}：{pending.account.mailbox?.email ?? '未关联'} →{' '}
              {pending.mailbox?.email ?? '解除关联'}。
            </p>
            <p className="m-0 text-secondary text-text-soft-400">
              {pending.account.mailbox
                ? '这会替换或解除当前关系。'
                : '确认后才会建立关系。'}{' '}
              邮箱与账号资料均保留。写入前会核对邮箱身份及当前关系。
            </p>
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              返回选择
            </Button>
          </>
        ) : (
          <>
            {account?.mailbox && (
              <div className="flex items-center justify-between gap-2 rounded-control bg-bg-weak-50 p-3">
                <span className="text-secondary text-text-sub-600">
                  当前：{account.mailbox.email}
                </span>
                <Button
                  size="xsmall"
                  mode="stroke"
                  variant="neutral"
                  onClick={() => setPending({ account, mailbox: null })}
                >
                  解除关联
                </Button>
              </div>
            )}
            {account && !canChooseMailbox ? (
              <Alert status="warning" variant="lighter">
                邮箱插件未就绪。仍可解除已有关系；选择新邮箱需要启用并授权邮箱插件。
              </Alert>
            ) : (
              <>
                <Input
                  inputSize="xsmall"
                  label={account ? '搜索邮箱' : '搜索账号'}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setPage(1)
                  }}
                />
                <div className="max-h-72 overflow-y-auto divide-y divide-stroke-soft-200">
                  {account
                    ? mailboxes.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-2 py-3"
                        >
                          <span className="truncate text-secondary text-text-sub-600">
                            {item.email}
                            {item.enabled ? '' : ' · 已暂停'}
                          </span>
                          <Button
                            size="xsmall"
                            mode="stroke"
                            variant="neutral"
                            disabled={
                              loading ||
                              !item.enabled ||
                              item.id === account.mailbox?.mailboxId
                            }
                            onClick={() => setPending({ account, mailbox: item })}
                          >
                            {item.id === account.mailbox?.mailboxId ? '已关联' : '选择'}
                          </Button>
                        </div>
                      ))
                    : accounts.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-2 py-3"
                        >
                          <span className="min-w-0">
                            <strong className="block truncate font-medium text-text-strong-950">
                              {item.account}
                            </strong>
                            <span className="text-micro text-text-soft-400">
                              {item.mailbox?.email ?? '未关联邮箱'}
                            </span>
                          </span>
                          <Button
                            size="xsmall"
                            mode="stroke"
                            variant="neutral"
                            disabled={
                              loading ||
                              (!mailbox?.enabled &&
                                item.mailbox?.mailboxId !== mailbox?.id)
                            }
                            onClick={() => {
                              if (mailbox)
                                setPending({
                                  account: item,
                                  mailbox:
                                    item.mailbox?.mailboxId === mailbox.id
                                      ? null
                                      : mailbox,
                                })
                            }}
                          >
                            {item.mailbox?.mailboxId === mailbox?.id
                              ? '解除关联'
                              : item.mailbox
                                ? '替换关联'
                                : '关联'}
                          </Button>
                        </div>
                      ))}
                  {!loading && !(account ? mailboxes.length : accounts.length) && (
                    <p className="text-secondary text-text-soft-400">没有匹配结果</p>
                  )}
                  {loading && (
                    <p className="text-secondary text-text-soft-400">读取中…</p>
                  )}
                </div>
                <div className="flex items-center justify-end gap-2">
                  <span className="text-secondary text-text-soft-400">
                    第 {page} / {Math.max(1, Math.ceil(total / 20))} 页
                  </span>
                  <Button
                    size="xsmall"
                    mode="stroke"
                    variant="neutral"
                    disabled={loading || page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    上一页
                  </Button>
                  <Button
                    size="xsmall"
                    mode="stroke"
                    variant="neutral"
                    disabled={loading || page * 20 >= total}
                    onClick={() => setPage(page + 1)}
                  >
                    下一页
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </DialogModal>
  )
}
