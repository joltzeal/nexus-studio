import { useState, type FormEvent } from 'react'
import { UserPlus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { toast } from '@/components/ui/toast'
import { attachNumber, type AccountTarget } from './accounts-bridge'
import { message, type SmsRecord } from './types'

/**
 * Writes one purchased number into a Vinted account: the number itself plus the
 * record link, which is what the account page's 手机验证码 button reads.
 */
export function LinkAccountDialog({
  record,
  accounts,
  onDone,
  onClose,
}: {
  record: SmsRecord
  accounts: AccountTarget[]
  onDone: () => void
  onClose: () => void
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const options = accounts.map((account) => ({
    value: account.id,
    label:
      account.phone === '' ? account.account : `${account.account} · ${account.phone}`,
  }))
  const target = accounts.find((account) => account.id === accountId) ?? null

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (accountId === '') {
      setError('先选择一个账号。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await attachNumber(accountId, record.tel, record.api)
      toast.success('号码已写入账号')
      onDone()
      onClose()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogContent className="sim8-link-dialog">
      <DialogHeader>
        <DialogTitle>写入 Vinted 账号</DialogTitle>
        <DialogDescription>
          把 {record.tel}{' '}
          和它的接码链接写进账号，之后在账号页点「手机验证码」就能直接取码。
        </DialogDescription>
      </DialogHeader>
      <form className="sim8-form" onSubmit={(event) => void submit(event)}>
        <Field>
          <FieldLabel htmlFor="sim8-link-account">账号</FieldLabel>
          {accounts.length === 0 ? (
            <FieldDescription>
              账号池里还没有账号。先到「插件中心 → Vinted 账号」添加一个。
            </FieldDescription>
          ) : (
            <LabeledSelect
              id="sim8-link-account"
              ariaLabel="选择要写入的账号"
              value={accountId}
              options={options}
              onValueChange={setAccountId}
            />
          )}
          {target === null ? null : (
            <FieldDescription>
              {target.phone === ''
                ? '该账号还没有手机号。'
                : `当前手机号：${target.phone}`}
              {target.smsOtpUrl === '' ? '' : '（已有接码链接，会被覆盖）'}
            </FieldDescription>
          )}
        </Field>
        <div className="sim8-readonly">
          <span>接码链接</span>
          <code>{record.api === '' ? '（空）' : record.api}</code>
        </div>
        {error === null ? null : <FieldError role="alert">{error}</FieldError>}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={busy || accounts.length === 0}>
            <UserPlus data-icon="inline-start" />
            {busy ? '写入中…' : '写入账号'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
