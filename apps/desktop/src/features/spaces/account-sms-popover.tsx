import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Copy, Loader2, Smartphone } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toast'
import { readOtp } from '@/features/accounts/api'
import {
  ContactChangedError,
  sameContact,
  updateConfirmedContact,
} from '@/features/accounts/confirmed-contact'
import {
  LOGIN_METHOD_LABELS,
  type Account,
  type OtpResult,
} from '@/features/accounts/types'
import type { ContactPatch } from '@/features/sim8/accounts-bridge'
import { NumberPoolList } from '@/features/sim8/number-picker'
import { copyText } from '@/lib/clipboard'

interface ContactChange {
  account: Account
  patch: ContactPatch
  changes: string[]
  done: string
}

async function copy(value: string, done: string) {
  if (await copyText(value)) toast.success(done)
  else toast.error('复制失败，请检查剪贴板权限后重试。')
}

export function AccountPhoneCopy({ account }: { account: Account }) {
  if (account.phone.trim() === '') return null
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="account-phone-copy"
      aria-label={`复制 ${account.account} 的手机号 ${account.phone}`}
      title="复制手机号"
      onClick={() => void copy(account.phone, '手机号已复制')}
    >
      <span>{account.phone}</span>
      <Copy aria-hidden="true" />
    </Button>
  )
}

export function AccountSmsPopover({
  account,
  ready,
  onSaved,
}: {
  account: Account
  ready: boolean
  onSaved: (account: Account) => void
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('read')
  const [draftUrl, setDraftUrl] = useState<string | null>(null)
  const [pending, setPending] = useState<'save' | 'read' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastRead, setLastRead] = useState<{
    url: string
    result: OtpResult
  } | null>(null)
  const currentAccount = useRef(account)
  const available = useRef(ready)
  available.current = ready
  const busy = useRef(false)
  const [confirmation, setConfirmation] = useState<ContactChange | null>(null)
  const confirmedChange = useRef<ContactChange | null>(null)
  const urlId = useId()
  const url = draftUrl ?? account.smsOtpUrl
  const dirty = url.trim() !== account.smsOtpUrl.trim()
  const hasLink = account.smsOtpUrl.trim() !== ''
  const result = lastRead?.url === account.smsOtpUrl ? lastRead.result : null
  const locked = pending !== null || confirmation !== null

  useEffect(() => {
    currentAccount.current = account
  }, [account])

  function requestChange(patch: ContactPatch, done: string) {
    if (busy.current || !available.current || confirmedChange.current) return
    const saved = currentAccount.current
    const changes: string[] = []
    if (saved.phone.trim() && patch.phone !== undefined && patch.phone !== saved.phone) {
      changes.push(`将手机号「${saved.phone}」替换为「${patch.phone}」`)
    }
    if (
      saved.smsOtpUrl.trim() &&
      patch.smsOtpUrl !== undefined &&
      patch.smsOtpUrl !== saved.smsOtpUrl
    ) {
      changes.push('替换短信接码链接')
    }
    const change = { account: saved, patch, changes, done }
    setError(null)
    if (changes.length) {
      confirmedChange.current = change
      setConfirmation(change)
    } else {
      void apply(change)
    }
  }

  async function apply(change: ContactChange) {
    if (
      busy.current ||
      !available.current ||
      (confirmedChange.current && confirmedChange.current !== change)
    )
      return
    busy.current = true
    setPending('save')
    setError(null)
    try {
      const saved = await updateConfirmedContact(change.account, change.patch, () => {
        if (!available.current) throw new Error('账号插件暂不可用')
        if (!sameContact(currentAccount.current, change.account)) {
          throw new ContactChangedError()
        }
      })
      // Refresh immediately: the next read must use the persisted account.
      currentAccount.current = saved
      confirmedChange.current = null
      setConfirmation(null)
      onSaved(saved)
      setDraftUrl(null)
      setLastRead(null)
      setTab('read')
      toast.success(change.done)
    } catch (cause) {
      setError(
        cause instanceof ContactChangedError
          ? cause.message
          : '保存失败，请检查插件状态或刷新账号资料后重试。',
      )
    } finally {
      busy.current = false
      setPending(null)
    }
  }

  function saveLink(event: FormEvent) {
    event.preventDefault()
    if (busy.current || !available.current || confirmedChange.current) return
    const next = url.trim()
    if (next === '') {
      setError('先填接码链接。')
      return
    }
    requestChange({ smsOtpUrl: next }, '接码链接已保存到账号')
  }

  async function fetchCode() {
    if (busy.current || !available.current || confirmedChange.current) return
    const saved = currentAccount.current
    if ((draftUrl ?? saved.smsOtpUrl).trim() !== saved.smsOtpUrl.trim()) {
      setError('接码链接有未保存的修改，请先保存后取码。')
      return
    }
    if (saved.smsOtpUrl.trim() === '') return
    busy.current = true
    setPending('read')
    setError(null)
    setLastRead(null)
    try {
      const response = await readOtp(saved.id, 'sms')
      setLastRead({ url: saved.smsOtpUrl, result: response })
    } catch {
      setError('读取验证码失败，请检查已保存的接码链接或插件状态后重试。')
    } finally {
      busy.current = false
      setPending(null)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (busy.current || confirmedChange.current) return
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="account-phone-trigger"
          data-has-phone={account.phone.trim() !== '' ? 'true' : undefined}
          aria-label={`管理 ${account.account} 的手机号与短信验证码`}
          title="手机号与短信验证码"
          disabled={!ready}
        >
          <Smartphone aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="account-sms-quick account-compact-popover">
        <PopoverHeader>
          <PopoverTitle>账号手机号与接码</PopoverTitle>
        </PopoverHeader>
        <div className="account-sms-identity">
          <strong>{account.account}</strong>
          <small>Vinted 账号 · {LOGIN_METHOD_LABELS[account.loginMethod]}登录</small>
          {account.phone.trim() === '' ? (
            <small>尚未设置手机号</small>
          ) : (
            <AccountPhoneCopy account={account} />
          )}
        </div>
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (!busy.current && !confirmedChange.current) setTab(value)
          }}
          className="account-popover-tabs"
        >
          <TabsList aria-label="账号手机号操作">
            <TabsTrigger value="read" disabled={locked}>
              验证码
            </TabsTrigger>
            <TabsTrigger value="pool" disabled={locked}>
              号码池
            </TabsTrigger>
            <TabsTrigger value="link" disabled={locked}>
              编辑链接
            </TabsTrigger>
          </TabsList>
          <TabsContent value="read">
            <div className="grid gap-2">
              <p className="otp-hint">
                {dirty
                  ? '接码链接有未保存的修改，请先保存后取码。'
                  : hasLink
                    ? '读取此账号已保存的手机接码链接。'
                    : '尚未保存接码链接，请选择号码或编辑链接。'}
              </p>
              <Button
                type="button"
                size="sm"
                disabled={!ready || locked || dirty || !hasLink}
                onClick={() => void fetchCode()}
              >
                {pending === 'read' ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : null}
                {pending === 'read' ? '正在读取…' : '读取短信验证码'}
              </Button>
              {result === null ? null : (
                <div className="account-sms-result grid gap-2">
                  <div className="flex items-center justify-between gap-2" role="status">
                    {result.code === null ? (
                      <span className="otp-hint">未找到唯一验证码，请查看原文。</span>
                    ) : (
                      <>
                        <output className="account-sms-code" aria-label="短信验证码">
                          {result.code}
                        </output>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => {
                            if (result.code !== null) {
                              void copy(result.code, '验证码已复制')
                            }
                          }}
                        >
                          <Copy data-icon="inline-start" />
                          复制验证码
                        </Button>
                      </>
                    )}
                  </div>
                  <details open={result.code === null}>
                    <summary className="cursor-pointer text-xs">查看响应原文</summary>
                    <div className="grid gap-2 pt-2">
                      <pre className="otp-raw">
                        {result.body.trim() === '' ? '（响应体为空）' : result.body}
                      </pre>
                      {result.truncated ? (
                        <p className="otp-hint">响应较长，仅显示前 64 KB。</p>
                      ) : null}
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={result.body === ''}
                        onClick={() => void copy(result.body, '响应原文已复制')}
                      >
                        <Copy data-icon="inline-start" />
                        复制原文
                      </Button>
                    </div>
                  </details>
                </div>
              )}
            </div>
          </TabsContent>
          <TabsContent value="pool">
            <NumberPoolList
              currentAccountId={account.id}
              disabled={!ready || locked}
              onPick={(number) =>
                requestChange(
                  { phone: number.tel.trim(), smsOtpUrl: number.api.trim() },
                  '号码和接码链接已保存到账号',
                )
              }
            />
          </TabsContent>
          <TabsContent value="link">
            <form className="account-quick-form" onSubmit={saveLink}>
              <Field>
                <FieldLabel htmlFor={urlId}>手机接码链接</FieldLabel>
                <Input
                  id={urlId}
                  autoComplete="off"
                  placeholder="https://…"
                  maxLength={2048}
                  disabled={!ready || locked}
                  value={url}
                  onChange={(event) => {
                    if (!busy.current && !confirmedChange.current)
                      setDraftUrl(event.target.value)
                  }}
                />
              </Field>
              <p className="otp-hint">保存到此账号，保留原有手机号。</p>
              <div className="account-quick-actions">
                <Button type="submit" size="sm" disabled={!ready || locked || !dirty}>
                  {pending === 'save' ? '保存中…' : '保存链接'}
                </Button>
              </div>
            </form>
          </TabsContent>
        </Tabs>
        {error === null ? null : <FieldError role="alert">{error}</FieldError>}
      </PopoverContent>
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(next) => {
          if (!next && !busy.current) {
            confirmedChange.current = null
            setConfirmation(null)
            setError(null)
          }
        }}
      >
        {confirmation === null ? null : (
          <AlertDialogContent
            onEscapeKeyDown={(event) => {
              if (busy.current) event.preventDefault()
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>确认替换账号联系方式？</AlertDialogTitle>
              <AlertDialogDescription>
                高风险操作：账号「{confirmation.account.account}」将
                {confirmation.changes.join('、')}，影响此账号的所有关联窗口，
                可能导致无法接收登录或找回验证码。只修改 Raccoon 保存的资料，SIM8 号码池和
                Vinted 平台资料会保留。
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error === null ? null : <FieldError role="alert">{error}</FieldError>}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending === 'save'}>取消</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={!ready || pending !== null}
                onClick={(event) => {
                  event.preventDefault()
                  void apply(confirmation)
                }}
              >
                {pending === 'save' ? '保存中…' : '确认替换'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </Popover>
  )
}
