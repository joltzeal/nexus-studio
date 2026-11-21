import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  DialogModal,
  Input,
  Select,
  Textarea,
} from '@proxyshard/shardx-ui-kit'
import { accountContactChanges } from '../../../raccoon/plugins/vinted-accounts/contact-confirmation'
import { Sim8NumberPicker } from './Sim8NumberPicker'
import {
  ACCOUNT_STATUS_LABELS,
  DEFAULT_ACCOUNT_STATUS,
  LOGIN_LABELS,
  LOGIN_METHODS,
  type Account,
  type AccountStatus,
  type LoginMethod,
} from '../../../raccoon/plugins/vinted-accounts/model'

export type AccountDraft = {
  id?: string
  expectedUpdatedAt?: string
  loginMethod: LoginMethod
  account: string
  password: string
  phone: string
  emailOtpUrl: string
  smsOtpUrl: string
  note: string
  status: AccountStatus
  homepageUrl: string
}
const empty: AccountDraft = {
  loginMethod: 'email',
  account: '',
  password: '',
  phone: '',
  emailOtpUrl: '',
  smsOtpUrl: '',
  note: '',
  status: DEFAULT_ACCOUNT_STATUS,
  homepageUrl: '',
}

export function AccountForm({
  account,
  busy,
  error,
  onSave,
  onClose,
}: {
  account: Account | null
  busy: boolean
  error: string | null
  onSave: (value: AccountDraft) => Promise<void>
  onClose: () => void
}) {
  const [draft, setDraft] = useState<AccountDraft>(empty)
  const [confirmation, setConfirmation] = useState<{
    input: AccountDraft
    source: Account
    changes: string[]
  } | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const saving = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  useEffect(() => {
    setDraft(
      account
        ? {
            id: account.id,
            expectedUpdatedAt: account.updatedAt,
            loginMethod: account.loginMethod,
            account: account.account,
            password: account.password,
            phone: account.phone,
            emailOtpUrl: account.emailOtpUrl,
            smsOtpUrl: account.smsOtpUrl,
            note: account.note,
            status: account.status,
            homepageUrl: account.homepageUrl,
          }
        : empty,
    )
  }, [account])
  const change = (key: keyof AccountDraft, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }))
  const locked = busy || pending
  const disabled = locked || confirmation !== null
  const missingPassword = (!account || account.password !== '') && draft.password === ''
  const submit = () => {
    if (saving.current || disabled || !draft.account.trim() || missingPassword) return
    const input = {
      ...draft,
      account: draft.account.trim(),
      note: draft.note.trim(),
      phone: draft.phone.trim(),
      emailOtpUrl: draft.emailOtpUrl.trim(),
      smsOtpUrl: draft.smsOtpUrl.trim(),
      homepageUrl: draft.homepageUrl.trim(),
    }
    setLocalError(null)
    const changes = accountContactChanges(account, input)
    if (account && changes.length) setConfirmation({ input, source: account, changes })
    else void save(input)
  }
  async function save(input: AccountDraft, source?: Account) {
    if (saving.current || busy) return
    if (
      source &&
      (!account ||
        account.id !== source.id ||
        account.updatedAt !== source.updatedAt ||
        accountContactChanges(source, account).length)
    ) {
      setLocalError('账号资料已变化，请取消确认并重新核对。')
      return
    }
    saving.current = true
    setPending(true)
    setLocalError(null)
    try {
      await onSave(input)
    } catch {
      if (active.current) setLocalError('账号保存失败，请检查插件状态或重新读取后重试。')
    } finally {
      saving.current = false
      if (active.current) setPending(false)
    }
  }
  const close = () => {
    if (!saving.current && !disabled) onClose()
  }
  const cancelConfirmation = () => {
    if (!saving.current && !locked) {
      setConfirmation(null)
      setLocalError(null)
    }
  }
  return (
    <>
      <DialogModal
        open
        title={account ? '编辑 Vinted 账号' : '添加 Vinted 账号'}
        subtitle="保存账号资料不会尝试登录 Vinted。凭据保存在账号池插件私有目录。"
        dirty={
          JSON.stringify(draft) !==
          JSON.stringify(
            account
              ? {
                  id: account.id,
                  expectedUpdatedAt: account.updatedAt,
                  loginMethod: account.loginMethod,
                  account: account.account,
                  password: account.password,
                  phone: account.phone,
                  emailOtpUrl: account.emailOtpUrl,
                  smsOtpUrl: account.smsOtpUrl,
                  note: account.note,
                  status: account.status,
                  homepageUrl: account.homepageUrl,
                }
              : empty,
          )
        }
        isLoading={locked}
        isDisabled={confirmation !== null || !draft.account.trim() || missingPassword}
        confirmLabel="保存账号"
        onConfirm={submit}
        onCancel={close}
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="登录方式"
            size="xsmall"
            value={draft.loginMethod}
            disabled={disabled}
            onChange={(value) => change('loginMethod', value)}
            options={LOGIN_METHODS.map((value) => ({
              value,
              label: LOGIN_LABELS[value],
            }))}
          />
          <Select
            label="账号状态"
            size="xsmall"
            value={draft.status}
            disabled={disabled}
            onChange={(value) => change('status', value)}
            options={Object.entries(ACCOUNT_STATUS_LABELS).map(([value, label]) => ({
              value,
              label,
            }))}
          />
          <Input
            inputSize="xsmall"
            label="登录邮箱或账号"
            value={draft.account}
            disabled={disabled}
            onChange={(event) => change('account', event.target.value)}
          />
          <Input
            inputSize="xsmall"
            secret
            label="密码"
            type="password"
            value={draft.password}
            disabled={disabled}
            onChange={(event) => change('password', event.target.value)}
            hint={
              account
                ? account.password !== ''
                  ? '已有密码不可清空，可填写新密码替换'
                  : '此账号尚未设置密码，可暂时留空'
                : '手动添加需要密码'
            }
          />
          <div className="flex items-end gap-2">
            <Input
              inputSize="xsmall"
              label="手机号"
              value={draft.phone}
              disabled={disabled}
              onChange={(event) => change('phone', event.target.value)}
            />
            <Sim8NumberPicker
              disabled={disabled}
              currentAccountId={account?.id}
              onPick={({ tel, api }) => {
                if (!disabled && !saving.current)
                  setDraft((current) => ({ ...current, phone: tel, smsOtpUrl: api }))
              }}
            />
          </div>
          <Input
            inputSize="xsmall"
            label="主页链接"
            value={draft.homepageUrl}
            disabled={disabled}
            onChange={(event) => change('homepageUrl', event.target.value)}
          />
          <Input
            inputSize="xsmall"
            label="邮箱验证码链接"
            value={draft.emailOtpUrl}
            disabled={disabled}
            onChange={(event) => change('emailOtpUrl', event.target.value)}
          />
          <Input
            inputSize="xsmall"
            label="短信验证码链接"
            value={draft.smsOtpUrl}
            disabled={disabled}
            onChange={(event) => change('smsOtpUrl', event.target.value)}
          />
          <Textarea
            className="sm:col-span-2"
            label="备注"
            rows={3}
            value={draft.note}
            disabled={disabled}
            onChange={(event) => change('note', event.target.value)}
          />
          {(error || localError) && confirmation === null && (
            <Alert className="sm:col-span-2" status="error" variant="lighter">
              {localError ?? error}
            </Alert>
          )}
        </div>
      </DialogModal>
      {confirmation && (
        <DialogModal
          open
          title="确认修改账号联系方式"
          size="sm"
          showClose={false}
          subtitle={`将为账号「${confirmation.source.account}」${confirmation.changes.join('、')}。修改影响使用此账号的所有关联 Profile，并可能影响登录验证和账号找回。请核对资料后确认。`}
          isLoading={locked}
          confirmLabel="确认修改"
          confirmVariant="error"
          onConfirm={() => void save(confirmation.input, confirmation.source)}
          onCancel={cancelConfirmation}
          onOpenChange={(open) => {
            if (!open) cancelConfirmation()
          }}
          footer={
            <>
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={locked}
                onClick={cancelConfirmation}
              >
                取消
              </Button>
              <Button
                size="xsmall"
                variant="error"
                disabled={locked}
                isLoading={locked}
                onClick={() => void save(confirmation.input, confirmation.source)}
              >
                确认修改
              </Button>
            </>
          }
        >
          {(error || localError) && (
            <Alert status="error" variant="lighter">
              {localError ?? '保存失败，请检查插件状态或重新读取账号资料后重试。'}
            </Alert>
          )}
        </DialogModal>
      )}
    </>
  )
}
