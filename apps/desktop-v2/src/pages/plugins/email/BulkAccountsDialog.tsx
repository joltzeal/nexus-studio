import { useState } from 'react'
import { Alert, Button, DialogModal, Input, Select } from '@proxyshard/shardx-ui-kit'
import {
  accountsApi,
  supportsAccountBase,
  supportsAccountOptional,
} from '../../../raccoon/plugins/vinted-accounts/api'
import { createMailboxRelations } from '../../../raccoon/plugins/vinted-accounts/mailbox-relations'
import {
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_LABELS,
  DEFAULT_ACCOUNT_STATUS,
  LOGIN_LABELS,
  LOGIN_METHODS,
  type AccountStatus,
  type LoginMethod,
} from '../../../raccoon/plugins/vinted-accounts/model'
import { emailApi, supportsEmailBase } from '../../../raccoon/plugins/email/api'
import {
  mailboxImportInput,
  readMailboxImportPreview,
} from '../../../raccoon/plugins/email/bulk'
import type { MailboxIdentity } from '../../../raccoon/plugins/email/model'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import { usePluginTask } from '../usePluginTask'

export function BulkAccountsDialog({
  mailboxes,
  onClose,
  onSuccess,
}: {
  mailboxes: MailboxIdentity[]
  onClose: () => void
  onSuccess: (message: string) => void
}) {
  const task = usePluginTask()
  const [loginMethod, setLoginMethod] = useState<LoginMethod>('email')
  const [status, setStatus] = useState<AccountStatus>(DEFAULT_ACCOUNT_STATUS)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof readMailboxImportPreview>
  > | null>(null)
  const [identities] = useState(() => pluginIdentities())

  function pluginIdentities() {
    return ['studio.email', 'studio.vinted-accounts'].map((id) => {
      const plugin = usePluginCatalog.getState().plugins.find((item) => item.id === id)
      const available =
        id === 'studio.email'
          ? supportsEmailBase(plugin)
          : supportsAccountBase(plugin) &&
            supportsAccountOptional(plugin, 'mailbox') &&
            supportsAccountOptional(plugin, 'mailboxImport')
      return available
        ? `${plugin?.version}:${plugin?.installation ?? ''}:${plugin?.runtimeGeneration ?? ''}`
        : null
    })
  }
  function isCurrent(token: number) {
    const current = pluginIdentities()
    return (
      task.current(token) &&
      current.every(
        (identity, index) => identity !== null && identity === identities[index],
      )
    )
  }
  async function submit() {
    if (!task.acquire()) return
    const token = task.begin()
    setBusy(true)
    setError(null)
    try {
      const latest = await readMailboxImportPreview(
        mailboxes,
        (page) => accountsApi.mailboxTargets('', page, 50),
        () => isCurrent(token),
      )
      if (!isCurrent(token)) return
      if (!preview) {
        setPreview(latest)
        return
      }
      if (
        JSON.stringify(latest.expectedDuplicateIds) !==
          JSON.stringify(preview.expectedDuplicateIds) ||
        latest.skipped !== preview.skipped
      ) {
        setPreview(latest)
        throw new Error('账号池已变化，已更新重复检查，请重新确认')
      }
      const result = (await createMailboxRelations(accountsApi, emailApi).import(
        mailboxImportInput(
          mailboxes,
          { loginMethod, status, note },
          preview.expectedDuplicateIds,
        ),
        () => isCurrent(token),
      )) as { total: number; inserted: number; skipped: number }
      if (isCurrent(token))
        onSuccess(
          `本地账号池新增 ${result.inserted} 个，跳过重复邮箱 ${result.skipped} 个。`,
        )
    } catch (cause) {
      if (task.current(token))
        setError(
          cause instanceof Error ? cause.message : '账号创建失败，请重新核对后重试',
        )
    } finally {
      task.release()
      if (task.current(token)) setBusy(false)
    }
  }
  return (
    <DialogModal
      open
      title="从所选邮箱创建 Vinted 账号"
      size="lg"
      subtitle="在本地账号池保存邮箱登录标识与邮箱关联，账号密码为空。此操作不会在 Vinted 平台注册或登录。"
      isLoading={busy}
      isDisabled={preview?.skipped === mailboxes.length}
      confirmLabel={
        preview
          ? `确认创建 ${mailboxes.length - preview.skipped} 个账号`
          : '检查重复并核对'
      }
      onConfirm={() => void submit()}
      onCancel={() => {
        if (!busy) onClose()
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
        <p className="m-0 text-secondary text-text-sub-600">
          已选择 {mailboxes.length} 个邮箱
        </p>
        <div className="max-h-40 overflow-y-auto rounded-control bg-bg-weak-50 p-2 text-secondary text-text-sub-600">
          {mailboxes.map((mailbox) => (
            <div key={mailbox.id}>{mailbox.email}</div>
          ))}
        </div>
        {preview && (
          <>
            <Alert status={preview.skipped ? 'warning' : 'information'} variant="lighter">
              将新增 {mailboxes.length - preview.skipped} 个账号，跳过 {preview.skipped}{' '}
              个重复邮箱。现有账号资料和关联保留。
            </Alert>
            {preview.duplicates.length > 0 && (
              <div className="max-h-40 overflow-y-auto text-secondary text-text-sub-600">
                {preview.duplicates.map(({ mailbox, accounts }) => (
                  <div key={mailbox.mailboxId}>
                    {mailbox.email} · 已存在或已关联{' '}
                    {accounts.map((account) => account.account).join('、')}
                  </div>
                ))}
              </div>
            )}
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              返回修改并重新检查
            </Button>
          </>
        )}
        <Select
          label="登录方式"
          size="xsmall"
          value={loginMethod}
          disabled={busy || !!preview}
          onChange={(value) => setLoginMethod(value as LoginMethod)}
          options={LOGIN_METHODS.map((value) => ({ value, label: LOGIN_LABELS[value] }))}
        />
        <Select
          label="账号状态"
          size="xsmall"
          value={status}
          disabled={busy || !!preview}
          onChange={(value) => setStatus(value as AccountStatus)}
          options={ACCOUNT_STATUSES.map((value) => ({
            value,
            label: ACCOUNT_STATUS_LABELS[value],
          }))}
        />
        <Input
          inputSize="xsmall"
          label="统一备注"
          value={note}
          maxLength={200}
          disabled={busy || !!preview}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
    </DialogModal>
  )
}
