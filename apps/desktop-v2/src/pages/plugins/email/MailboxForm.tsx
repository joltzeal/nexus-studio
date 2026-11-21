import { useEffect, useState } from 'react'
import { Alert, DialogModal, Input, Select } from '@proxyshard/shardx-ui-kit'
import type { MailboxInput, MailboxView } from '../../../raccoon/plugins/email/model'

export function MailboxForm({
  mailbox,
  busy,
  error,
  onSave,
  onClose,
}: {
  mailbox: MailboxView | null
  busy: boolean
  error: string | null
  onSave: (input: MailboxInput) => void
  onClose: () => void
}) {
  const [transport, setTransport] = useState<'graph' | 'imap'>('graph')
  const [email, setEmail] = useState('')
  const [clientId, setClientId] = useState('')
  const [password, setPassword] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [note, setNote] = useState('')
  const [enabled, setEnabled] = useState(true)
  useEffect(() => {
    setTransport(mailbox?.transport ?? 'graph')
    setEmail(mailbox?.email ?? '')
    setClientId(mailbox?.clientId ?? '')
    setNote(mailbox?.note ?? '')
    setEnabled(mailbox?.enabled ?? true)
    setPassword('')
    setRefreshToken('')
  }, [mailbox])
  const input: MailboxInput = {
    ...(mailbox ? { id: mailbox.id } : {}),
    provider: 'microsoft',
    transport,
    email: email.trim(),
    clientId: clientId.trim(),
    ...(password ? { password } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    note: note.trim(),
    enabled,
  }
  const valid =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) &&
    /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.clientId) &&
    (mailbox !== null || refreshToken.trim().length > 0)
  return (
    <DialogModal
      open
      title={mailbox ? '编辑邮箱' : '添加邮箱'}
      subtitle="密码仅作资料保存，不会用于密码登录；Refresh token 和 Client ID 保存在邮箱插件私有目录。"
      size="md"
      dirty={
        Boolean(email || clientId || password || refreshToken || note) &&
        JSON.stringify(input) !== JSON.stringify(mailbox)
      }
      isLoading={busy}
      isDisabled={!valid}
      confirmLabel="保存邮箱"
      onConfirm={() => onSave(input)}
      onCancel={onClose}
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
        <Input
          inputSize="xsmall"
          label="邮箱地址"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Input
          inputSize="xsmall"
          label="Microsoft Client ID"
          technical
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
        />
        <Select
          label="收信方式"
          size="xsmall"
          value={transport}
          onChange={(value) => setTransport(value as 'graph' | 'imap')}
          options={[
            { value: 'graph', label: 'Microsoft Graph' },
            { value: 'imap', label: 'OAuth IMAP' },
          ]}
        />
        <Input
          inputSize="xsmall"
          secret
          label="Refresh token"
          type="password"
          value={refreshToken}
          onChange={(event) => setRefreshToken(event.target.value)}
          hint={
            mailbox?.hasRefreshToken ? '已保存；留空保持现有 token' : '新增邮箱需要 token'
          }
        />
        <Input
          inputSize="xsmall"
          secret
          label="密码（仅资料）"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint={mailbox?.hasPassword ? '已保存；留空保持现有密码' : '不参与自动登录'}
        />
        <Input
          inputSize="xsmall"
          label="备注"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <Select
          label="邮箱状态"
          size="xsmall"
          value={String(enabled)}
          onChange={(value) => setEnabled(value === 'true')}
          options={[
            { value: 'true', label: '启用' },
            { value: 'false', label: '暂停' },
          ]}
        />
        <p className="m-0 text-secondary text-text-soft-400">
          编辑时留空凭据会保留旧值。定时刷新、收信仍由插件调度。
        </p>
      </div>
    </DialogModal>
  )
}
