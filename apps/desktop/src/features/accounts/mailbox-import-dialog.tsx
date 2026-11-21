import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import { toast } from '@/components/ui/toast'
import type { MailboxTarget } from '@/features/email/types'
import { importMailboxes, listAccounts } from './api'
import { readMailboxes } from './mailbox-import-source'
import {
  ACCOUNT_STATUSES,
  LOGIN_METHODS,
  LOGIN_METHOD_LABELS,
  STATUS_LABELS,
  message,
  type MailboxImportInput,
} from './types'

export function MailboxImportDialog({
  onImported,
  onClose,
}: {
  onImported: () => Promise<void>
  onClose: () => void
}) {
  const [mailboxes, setMailboxes] = useState<MailboxTarget[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [fields, setFields] = useState<
    Omit<MailboxImportInput, 'mailboxes' | 'expectedDuplicateIds'>
  >({
    loginMethod: 'email',
    phone: '',
    emailOtpUrl: '',
    smsOtpUrl: '',
    status: 'unknown',
    homepageUrl: '',
    note: '',
  })
  const [preview, setPreview] = useState<{
    mailboxes: { mailboxId: string; email: string }[]
    duplicates: { id: string; email: string }[]
  } | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)

  async function reload() {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError(null)
    setPreview(null)
    try {
      const items = await readMailboxes()
      setMailboxes(items)
      setSelected(new Set(items.map((item) => item.id)))
    } catch (cause) {
      setError(message(cause))
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void reload()
    })
    return () => {
      active = false
    }
  }, [])

  function change(patch: Partial<typeof fields>) {
    setFields((current) => ({ ...current, ...patch }))
    setPreview(null)
  }

  async function inspect() {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError(null)
    try {
      const currentMailboxes = await readMailboxes()
      setMailboxes(currentMailboxes)
      const available = new Map(currentMailboxes.map((item) => [item.id, item]))
      const chosen = [...selected].map((id) => available.get(id))
      if (!chosen.length || chosen.some((item) => item === undefined))
        throw new Error('选择的邮箱已变化，请刷新后重新选择。')
      if (chosen.some((item) => item!.email.length > 190))
        throw new Error('账号池最多支持 190 字符的邮箱地址，请取消选择超长邮箱。')
      const accounts = await listAccounts()
      const existing = new Map(
        accounts.items.map((item) => [item.account.toLowerCase(), item]),
      )
      setPreview({
        mailboxes: chosen.map((item) => ({ mailboxId: item!.id, email: item!.email })),
        duplicates: chosen.flatMap((item) => {
          const match = existing.get(item!.email.toLowerCase())
          return match ? [{ id: match.id, email: item!.email }] : []
        }),
      })
    } catch (cause) {
      setPreview(null)
      setError(message(cause))
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  async function submit() {
    if (busy.current || !preview) return
    busy.current = true
    setPending(true)
    setError(null)
    try {
      const current = await readMailboxes()
      const lookup = new Map(current.map((item) => [item.id, item.email]))
      if (
        preview.mailboxes.some(({ mailboxId, email }) => lookup.get(mailboxId) !== email)
      )
        throw new Error('邮箱资料已变化，请重新检查重复账号。')
      const result = await importMailboxes({
        ...fields,
        mailboxes: preview.mailboxes,
        expectedDuplicateIds: preview.duplicates.map((item) => item.id),
      })
      setPreview(null)
      toast.success(`从邮箱导入：新增 ${result.inserted}，跳过重复 ${result.skipped}`)
      try {
        await onImported()
      } catch {
        toast.error('导入已保存，账号列表刷新失败，请手动刷新。')
      }
      onClose()
    } catch (cause) {
      setPreview(null)
      setError(message(cause))
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  return (
    <DialogContent
      className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
      showCloseButton={!pending}
      onEscapeKeyDown={(event) => {
        if (pending) event.preventDefault()
      }}
      onInteractOutside={(event) => {
        if (pending) event.preventDefault()
      }}
    >
      <DialogHeader>
        <DialogTitle>从邮箱管理导入</DialogTitle>
        <DialogDescription>
          选中的邮箱作为账号，密码留空，并自动关联原邮箱。重复账号只跳过，不覆盖旧资料。
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div className="flex items-center justify-between text-sm">
          <span>
            邮箱 {mailboxes.length} 个 · 已选 {selected.size} 个
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => void reload()}
          >
            刷新邮箱
          </Button>
        </div>
        <div
          className="max-h-48 overflow-y-auto rounded-md border p-2"
          aria-label="邮箱列表"
        >
          {mailboxes.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无邮箱</p>
          ) : (
            mailboxes.map((item) => (
              <label key={item.id} className="flex items-center gap-2 py-1 text-sm">
                <Checkbox
                  checked={selected.has(item.id)}
                  disabled={pending}
                  onCheckedChange={(checked) => {
                    setSelected((current) => {
                      const next = new Set(current)
                      if (checked === true) next.add(item.id)
                      else next.delete(item.id)
                      return next
                    })
                    setPreview(null)
                  }}
                />
                <span className="min-w-0 truncate">{item.email}</span>
                {!item.enabled && <span className="text-muted-foreground">已暂停</span>}
              </label>
            ))
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel>登录方式</FieldLabel>
            <LabeledSelect
              ariaLabel="登录方式"
              value={fields.loginMethod}
              options={LOGIN_METHODS.map((value) => ({
                value,
                label: LOGIN_METHOD_LABELS[value],
              }))}
              onValueChange={(value) => {
                if (LOGIN_METHODS.includes(value as typeof fields.loginMethod))
                  change({ loginMethod: value as typeof fields.loginMethod })
              }}
              disabled={pending}
            />
          </Field>
          <Field>
            <FieldLabel>账号状态</FieldLabel>
            <LabeledSelect
              ariaLabel="账号状态"
              value={fields.status}
              options={ACCOUNT_STATUSES.map((value) => ({
                value,
                label: STATUS_LABELS[value],
              }))}
              onValueChange={(value) => {
                if (ACCOUNT_STATUSES.includes(value as typeof fields.status))
                  change({ status: value as typeof fields.status })
              }}
              disabled={pending}
            />
          </Field>
          {(
            [
              ['phone', '手机号'],
              ['emailOtpUrl', '邮箱接码链接'],
              ['smsOtpUrl', '短信接码链接'],
              ['homepageUrl', '主页链接'],
              ['note', '备注'],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} className={key === 'note' ? 'col-span-2' : undefined}>
              <FieldLabel htmlFor={`mailbox-import-${key}`}>{label}</FieldLabel>
              <Input
                id={`mailbox-import-${key}`}
                value={fields[key]}
                disabled={pending}
                onChange={(event) => change({ [key]: event.target.value })}
              />
            </Field>
          ))}
        </div>
        {preview && (
          <div className="rounded-md border p-3 text-sm" role="status">
            <p>
              将新增 {preview.mailboxes.length - preview.duplicates.length} 个，跳过重复{' '}
              {preview.duplicates.length} 个。是否继续？
            </p>
            {preview.duplicates.length > 0 && (
              <ul
                className="mt-2 max-h-24 overflow-y-auto text-muted-foreground"
                aria-label="重复邮箱"
              >
                {preview.duplicates.map((item) => (
                  <li key={item.id}>{item.email}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && <FieldError role="alert">{error}</FieldError>}
      </div>
      <DialogFooter>
        <Button variant="ghost" disabled={pending} onClick={onClose}>
          取消
        </Button>
        {preview ? (
          <Button
            disabled={pending || preview.mailboxes.length === preview.duplicates.length}
            onClick={() => void submit()}
          >
            确认导入
          </Button>
        ) : (
          <Button
            disabled={pending || selected.size === 0}
            onClick={() => void inspect()}
          >
            检查重复
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  )
}
