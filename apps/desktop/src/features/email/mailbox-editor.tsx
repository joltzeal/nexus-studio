import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { toast } from '@/components/ui/toast'
import { saveMailbox } from './api'
import { useEmailAction } from './hooks'
import type { MailboxView, MailTransport } from './types'

export function MailboxEditor({
  account,
  onClose,
  onSaved,
}: {
  account: MailboxView | null
  onClose: () => void
  onSaved: (account: MailboxView) => void
}) {
  const [email, setEmail] = useState(account?.email ?? '')
  const [clientId, setClientId] = useState(account?.clientId ?? '')
  const [transport, setTransport] = useState<MailTransport>(account?.transport ?? 'graph')
  const [password, setPassword] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [note, setNote] = useState(account?.note ?? '')
  const [enabled, setEnabled] = useState(account?.enabled ?? true)
  const [validation, setValidation] = useState<string | null>(null)
  const { action, busy, error } = useEmailAction(
    '邮箱保存失败，请检查资料和插件状态后重试。',
  )

  function close() {
    action.dispose()
    onClose()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setValidation('请输入有效的邮箱地址。')
      return
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        clientId.trim(),
      )
    ) {
      setValidation('Client ID 须为有效的应用 UUID。')
      return
    }
    if (
      (!account && !refreshToken.trim()) ||
      (refreshToken.trim() && /\s/.test(refreshToken.trim()))
    ) {
      setValidation('请填写所选通道已授权的 Refresh token，凭据中不能包含空白。')
      return
    }
    setValidation(null)
    void action.run(
      () =>
        saveMailbox({
          ...(account ? { id: account.id } : {}),
          provider: 'microsoft',
          transport,
          email: email.trim(),
          clientId: clientId.trim(),
          password,
          refreshToken,
          note: note.trim(),
          enabled,
        }),
      (saved) => {
        onSaved(saved)
        toast.success(account ? '邮箱已保存' : '邮箱已新增')
        close()
      },
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{account ? '编辑邮箱' : '新增邮箱'}</DialogTitle>
          <DialogDescription>
            微软邮箱 · 凭据明文保存在插件私有目录，密码仅作为资料保存。
          </DialogDescription>
        </DialogHeader>
        <form id="email-editor-form" onSubmit={submit} className="min-w-0">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="email-address">邮箱</FieldLabel>
              <Input
                id="email-address"
                type="email"
                autoComplete="off"
                required
                maxLength={254}
                value={email}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>收信通道</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                value={transport}
                disabled={busy}
                aria-label="收信通道"
                onValueChange={(value) => {
                  if (value === 'graph' || value === 'imap') setTransport(value)
                }}
              >
                <ToggleGroupItem value="graph">Graph</ToggleGroupItem>
                <ToggleGroupItem value="imap">IMAP</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                须已获得所选通道授权，权限失败不会自动切换通道。
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="email-client-id">Client ID</FieldLabel>
              <Input
                id="email-client-id"
                autoComplete="off"
                required
                maxLength={36}
                value={clientId}
                disabled={busy}
                onChange={(event) => setClientId(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="email-password">
                密码{account ? '（留空保留）' : '（可选）'}
              </FieldLabel>
              <Input
                id="email-password"
                type="password"
                autoComplete="new-password"
                maxLength={512}
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="email-refresh-token">
                Refresh token{account ? '（留空保留）' : ''}
              </FieldLabel>
              <Input
                id="email-refresh-token"
                type="password"
                autoComplete="new-password"
                required={!account}
                maxLength={16 * 1024}
                value={refreshToken}
                disabled={busy}
                onChange={(event) => setRefreshToken(event.target.value)}
              />
              {account ? (
                <FieldDescription>
                  不回显已保存的密码和 token；留空不会清除原值。
                </FieldDescription>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="email-note">备注</FieldLabel>
              <Textarea
                id="email-note"
                maxLength={1000}
                rows={2}
                value={note}
                disabled={busy}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="email-enabled">启用邮箱刷新</FieldLabel>
              <Switch
                id="email-enabled"
                checked={enabled}
                disabled={busy}
                onCheckedChange={setEnabled}
              />
            </Field>
            {validation || error ? <FieldError>{validation ?? error}</FieldError> : null}
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            取消
          </Button>
          <Button type="submit" form="email-editor-form" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
