import { useState, type FormEvent } from 'react'
import { Link2, Loader2, Unlink } from 'lucide-react'
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
import { LabeledSelect } from '@/components/ui/labeled-select'
import { toast } from '@/components/ui/toast'
import { STATUS_LABELS, type Account } from '@/features/accounts/types'
import {
  linkMailboxToAccount,
  loadAccountLinkTargets,
  loadMailboxLinkTargets,
  unlinkMailboxFromAccount,
} from './accounts-link'
import { EmailResource } from './async-state'
import { useEmailAction, useEmailResource } from './hooks'
import type { MailboxView } from './types'

type Result = Awaited<ReturnType<typeof linkMailboxToAccount>>
type Target = {
  id: string
  label: string
  current: string | null
  write: () => Promise<Result>
  unlink?: () => Promise<Result>
}
type TargetPage = { items: Target[]; total: number; page: number }
type PickerProps = {
  title: string
  subject: string
  query: string
  noun: '账号' | '邮箱'
  load: (input: { query: string; page: number }) => Promise<TargetPage>
  onClose: () => void
  onSaved?: (result: Result) => void
  onPendingChange?: (pending: boolean) => void
}

export function LinkMailboxAccountDialog({
  mailbox,
  onClose,
}: {
  mailbox: MailboxView
  onClose: () => void
}) {
  return (
    <LinkPicker
      title="关联账号"
      subject={mailbox.email}
      query={mailbox.email}
      noun="账号"
      onClose={onClose}
      load={async (input) => {
        const page = await loadAccountLinkTargets(input)
        return {
          ...page,
          items: page.items.map((target) => ({
            id: target.id,
            label: `${target.account} · ${STATUS_LABELS[target.status]}`,
            current: target.mailbox?.email ?? null,
            write: () =>
              linkMailboxToAccount(target.id, mailbox, target.mailbox?.mailboxId ?? null),
            ...(target.mailbox?.mailboxId === mailbox.id
              ? {
                  unlink: () =>
                    unlinkMailboxFromAccount(target.id, target.mailbox!.mailboxId),
                }
              : {}),
          })),
        }
      }}
    />
  )
}

export function LinkAccountMailboxDialog({
  account,
  onClose,
  onSaved,
  onPendingChange,
}: {
  account: Pick<Account, 'id' | 'account' | 'mailbox'>
  onClose: () => void
  onSaved: (result: Result) => void
  onPendingChange?: (pending: boolean) => void
}) {
  return (
    <LinkPicker
      title="关联邮箱"
      subject={account.account}
      query={/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.account) ? account.account : ''}
      noun="邮箱"
      onClose={onClose}
      onSaved={onSaved}
      {...(onPendingChange ? { onPendingChange } : {})}
      load={async (input) => {
        const page = await loadMailboxLinkTargets(input)
        return {
          ...page,
          items: page.items.map((target) => ({
            id: target.id,
            label: `${target.email}${target.enabled ? '' : ' · 已暂停'}`,
            current:
              target.id === account.mailbox?.mailboxId
                ? '此账号已关联该邮箱'
                : account.mailbox
                  ? `保存后替换 ${account.mailbox.email}`
                  : null,
            write: () =>
              linkMailboxToAccount(
                account.id,
                { id: target.id, email: target.email },
                account.mailbox?.mailboxId ?? null,
              ),
          })),
        }
      }}
    />
  )
}

function LinkPicker({
  title,
  subject,
  query,
  noun,
  load,
  onClose,
  onSaved,
  onPendingChange,
}: PickerProps) {
  const [resource] = useState(
    () =>
      new EmailResource(
        { query, page: 1 },
        load,
        `${noun}列表读取失败，请确认相关插件已启用并更新。`,
      ),
  )
  const state = useEmailResource(resource)
  const { action, busy, error } = useEmailAction('关联失败，请刷新资料后重试。')
  const [selectedId, setSelectedId] = useState('')
  const selected = state.value?.items.find((target) => target.id === selectedId)
  const page = state.value?.page ?? state.params.page

  function search(value: string) {
    if (busy) return
    setSelectedId('')
    resource.select({ query: value, page: 1 })
  }

  function write(target: Target, unlink = false) {
    if (busy || state.loading) return
    void action.run(
      async () => {
        onPendingChange?.(true)
        try {
          return await (unlink ? target.unlink!() : target.write())
        } finally {
          onPendingChange?.(false)
        }
      },
      (result) => {
        onSaved?.(result)
        toast.success(
          result.storageDurable
            ? unlink
              ? '邮箱关联已解除'
              : '邮箱已关联到账号'
            : '关联已修改，当前存储仅在内存中，重启后可能丢失。',
        )
        onClose()
      },
    )
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (selected) write(selected)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="break-all">
            {subject} · 同一邮箱可关联多个账号。
          </DialogDescription>
        </DialogHeader>
        <form className="flex min-w-0 flex-col gap-3" onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="mail-link-search">搜索{noun}</FieldLabel>
              <Input
                id="mail-link-search"
                maxLength={200}
                value={state.params.query}
                placeholder={noun === '账号' ? '账号或关联邮箱' : '邮箱或备注'}
                disabled={busy}
                onChange={(event) => search(event.target.value)}
              />
              <FieldDescription>清空搜索可选择其他{noun}。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>选择{noun}</FieldLabel>
              <LabeledSelect
                ariaLabel={`选择关联${noun}`}
                value={selectedId}
                disabled={busy || state.loading}
                onValueChange={setSelectedId}
                options={(state.value?.items ?? []).map((target) => ({
                  value: target.id,
                  label: `${target.label}${target.current ? ` · ${target.current}` : ''}`,
                }))}
              />
              {state.loading ? (
                <p role="status" className="text-xs text-muted-foreground">
                  正在读取{noun}…
                </p>
              ) : state.value?.items.length === 0 ? (
                <FieldDescription>
                  没有匹配的{noun}，可清空搜索或先添加资料。
                </FieldDescription>
              ) : null}
              {selected?.current ? (
                <FieldDescription>
                  当前关联：{selected.current}。确认后只更新邮箱关联，保留其他账号资料。
                </FieldDescription>
              ) : null}
            </Field>
          </FieldGroup>
          {(state.value?.total ?? 0) > 10 ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                共 {state.value?.total} 个{noun} · 第 {page} 页
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || state.loading || page <= 1}
                  onClick={() => {
                    setSelectedId('')
                    resource.select({ ...state.params, page: page - 1 })
                  }}
                >
                  上一页
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || state.loading || page * 10 >= state.value!.total}
                  onClick={() => {
                    setSelectedId('')
                    resource.select({ ...state.params, page: page + 1 })
                  }}
                >
                  下一页
                </Button>
              </div>
            </div>
          ) : null}
          {state.error || error ? (
            <FieldError role="alert">{error ?? state.error}</FieldError>
          ) : null}
          <DialogFooter>
            {selected?.unlink ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy || state.loading}
                onClick={() => write(selected, true)}
              >
                <Unlink data-icon="inline-start" />
                解除此账号的邮箱关联
              </Button>
            ) : null}
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy || state.loading || !selected}>
              {busy ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Link2 data-icon="inline-start" />
              )}
              {busy ? '正在保存…' : title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
