import { useRef, useState, type FormEvent } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { NumberPoolPicker } from '@/features/sim8/number-picker'
import {
  ACCOUNT_STATUSES,
  EMPTY_ACCOUNT,
  LOGIN_METHODS,
  LOGIN_METHOD_LABELS,
  STATUS_LABELS,
  message,
  type Account,
  type AccountInput,
  type LoginMethod,
} from './types'

export function AccountEditor({
  account,
  ready,
  description,
  onSave,
  onCancel,
}: {
  account: Account | null
  ready: boolean
  description?: string
  onSave: (input: AccountInput) => Promise<void>
  onCancel: () => void
}) {
  const [input, setInput] = useState<AccountInput>(() =>
    account === null
      ? { ...EMPTY_ACCOUNT }
      : {
          id: account.id,
          loginMethod: account.loginMethod,
          account: account.account,
          password: account.password,
          phone: account.phone,
          emailOtpUrl: account.emailOtpUrl,
          smsOtpUrl: account.smsOtpUrl,
          note: account.note,
          status: account.status,
          homepageUrl: account.homepageUrl,
        },
  )
  const [revealed, setRevealed] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saving = useRef(false)
  const disabled = pending || !ready

  function patch(changes: Partial<AccountInput>) {
    setInput((current) => ({ ...current, ...changes }))
    setError(null)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving.current || !ready) return
    if (input.account.trim() === '') {
      setError('请填写账号。')
      return
    }
    if (input.password === '') {
      setError('请填写密码。')
      return
    }
    saving.current = true
    setPending(true)
    setError(null)
    try {
      await onSave({ ...input, account: input.account.trim() })
    } catch (cause) {
      setError(message(cause))
    } finally {
      saving.current = false
      setPending(false)
    }
  }

  return (
    <DialogContent
      className="window-editor"
      showCloseButton={!pending}
      onEscapeKeyDown={(event) => {
        if (saving.current) event.preventDefault()
      }}
      onInteractOutside={(event) => {
        if (saving.current) event.preventDefault()
      }}
    >
      <DialogHeader>
        <DialogTitle>{account ? '编辑账号' : '新增账号'}</DialogTitle>
        <DialogDescription>
          {description ??
            (account
              ? '登录方式与账密是必填项。'
              : '登录方式与账密是必填项，其余可以留空。')}
        </DialogDescription>
      </DialogHeader>
      <form
        id="account-form"
        className="window-form"
        onSubmit={(event) => void submit(event)}
      >
        <div className="grid gap-3">
          <div className="window-form-grid">
            <Field>
              <FieldLabel htmlFor="account-method">登录方式</FieldLabel>
              <Select
                value={input.loginMethod}
                disabled={disabled}
                onValueChange={(value) => {
                  if (LOGIN_METHODS.includes(value as LoginMethod)) {
                    patch({ loginMethod: value as LoginMethod })
                  }
                }}
              >
                <SelectTrigger id="account-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {LOGIN_METHODS.map((method) => (
                      <SelectItem key={method} value={method}>
                        {LOGIN_METHOD_LABELS[method]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="account-status">账号状态</FieldLabel>
              <Select
                value={input.status}
                disabled={disabled}
                onValueChange={(value) => {
                  if (ACCOUNT_STATUSES.includes(value as Account['status'])) {
                    patch({ status: value as Account['status'] })
                  }
                }}
              >
                <SelectTrigger id="account-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {ACCOUNT_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {STATUS_LABELS[status]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="account-name">账号</FieldLabel>
            <Input
              id="account-name"
              autoFocus
              maxLength={190}
              disabled={disabled}
              placeholder="邮箱或用户名"
              value={input.account}
              onChange={(event) => patch({ account: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="account-password">密码</FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                id="account-password"
                type={revealed ? 'text' : 'password'}
                maxLength={190}
                autoComplete="off"
                disabled={disabled}
                value={input.password}
                onChange={(event) => patch({ password: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={revealed ? '隐藏密码' : '显示密码'}
                onClick={() => setRevealed((current) => !current)}
              >
                {revealed ? <EyeOff /> : <Eye />}
              </Button>
            </div>
          </Field>
          <div className="window-form-grid">
            <Field>
              <FieldLabel htmlFor="account-phone">手机号</FieldLabel>
              <div className="sim8-phone-field">
                <Input
                  id="account-phone"
                  maxLength={40}
                  disabled={disabled}
                  value={input.phone}
                  onChange={(event) => patch({ phone: event.target.value })}
                />
                <NumberPoolPicker
                  disabled={disabled}
                  currentAccountId={account?.id}
                  ariaLabel="从号码池选择手机号和接码链接"
                  onPick={(number) => patch({ phone: number.tel, smsOtpUrl: number.api })}
                />
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="account-homepage">主页链接</FieldLabel>
              <Input
                id="account-homepage"
                maxLength={2048}
                disabled={disabled}
                placeholder="https://www.vinted.fr/member/…"
                value={input.homepageUrl}
                onChange={(event) => patch({ homepageUrl: event.target.value })}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="account-email-otp">邮箱接码地址</FieldLabel>
            <Input
              id="account-email-otp"
              maxLength={2048}
              disabled={disabled}
              placeholder="接收邮箱验证码的接口地址"
              value={input.emailOtpUrl}
              onChange={(event) => patch({ emailOtpUrl: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="account-sms-otp">手机接码地址</FieldLabel>
            <Input
              id="account-sms-otp"
              maxLength={2048}
              disabled={disabled}
              placeholder="接收短信验证码的接口地址"
              value={input.smsOtpUrl}
              onChange={(event) => patch({ smsOtpUrl: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="account-note">备注</FieldLabel>
            <Input
              id="account-note"
              maxLength={200}
              disabled={disabled}
              value={input.note}
              onChange={(event) => patch({ note: event.target.value })}
            />
          </Field>
          {!ready ? (
            <FieldError role="alert">Vinted 账号插件尚未就绪，暂时无法保存。</FieldError>
          ) : null}
          {error ? <FieldError role="alert">{error}</FieldError> : null}
        </div>
      </form>
      <DialogFooter>
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" form="account-form" disabled={disabled}>
          {pending ? '正在保存…' : '保存账号'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
