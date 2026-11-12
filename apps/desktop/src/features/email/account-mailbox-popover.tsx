import { useEffect, useState } from 'react'
import { Copy, Link2, Loader2, Mail, Unlink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toast } from '@/components/ui/toast'
import { copyText } from '@/lib/clipboard'
import { listPlugins } from '@/lib/platform/native-plugins'
import type { Account } from '@/features/accounts/types'
import { resolveLinkedMailbox, unlinkMailboxFromAccount } from './accounts-link'
import { useEmailAction } from './hooks'
import { emailProcessIdentity } from './identity'
import { LinkAccountMailboxDialog } from './link-account-dialog'
import { MailReader } from './mail-reader'
import type { MailboxView } from './types'

type Result = Awaited<ReturnType<typeof unlinkMailboxFromAccount>>

export function AccountMailboxPopover({
  account,
  ready,
  onChanged,
  onPendingChange,
}: {
  account: Pick<Account, 'id' | 'account' | 'mailbox'>
  ready: boolean
  onChanged: (result: Result) => void
  onPendingChange?: (pending: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [linking, setLinking] = useState(false)
  const [reader, setReader] = useState<{ account: MailboxView; scope: string } | null>(
    null,
  )
  const { action, busy, error } = useEmailAction(
    '无法打开关联邮箱或修改关联，请检查插件状态并刷新资料后重试。',
  )
  const link = account.mailbox

  useEffect(() => {
    if (!reader) return
    let active = true
    let pending = false
    const check = async () => {
      if (pending) return
      pending = true
      let scope: string | null = null
      try {
        const plugins = await listPlugins()
        scope = emailProcessIdentity(
          plugins.find((plugin) => plugin.id === 'studio.email') ?? null,
          true,
        )
      } catch {
        // An unavailable host cannot safely continue an existing reader.
      } finally {
        pending = false
      }
      if (active && scope !== reader.scope) {
        setReader(null)
        toast.error('邮箱插件状态已变化，请重新打开邮件。')
      }
    }
    const timer = setInterval(() => void check(), 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [reader])

  function read() {
    if (!ready || !link) return
    void action.run(
      async () => {
        const mailbox = await resolveLinkedMailbox(link)
        const plugins = await listPlugins()
        const scope = emailProcessIdentity(
          plugins.find((plugin) => plugin.id === 'studio.email') ?? null,
          true,
        )
        if (!scope) throw new Error('邮箱插件不可用')
        return { account: mailbox, scope }
      },
      (result) => {
        setOpen(false)
        setReader(result)
      },
    )
  }

  function unlink() {
    if (!ready || !link) return
    void action.run(
      async () => {
        onPendingChange?.(true)
        try {
          return await unlinkMailboxFromAccount(account.id, link.mailboxId)
        } finally {
          onPendingChange?.(false)
        }
      },
      (result) => {
        onChanged(result)
        setOpen(false)
        toast.success(
          result.storageDurable
            ? '邮箱关联已解除'
            : '关联已解除，当前存储仅在内存中，重启后可能丢失。',
        )
      },
    )
  }

  return (
    <>
      {link ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`查看 ${account.account} 的关联邮箱`}
              className="max-w-44 justify-start px-0"
            >
              <Mail data-icon="inline-start" />
              <span className="truncate">{link.email}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80">
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm">{link.email}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="复制关联邮箱"
                  onClick={async () => {
                    if (await copyText(link.email)) toast.success('邮箱已复制')
                    else toast.error('复制失败，请重试。')
                  }}
                >
                  <Copy />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={!ready || busy} onClick={read}>
                  {busy ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <Mail data-icon="inline-start" />
                  )}
                  查看邮件
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!ready || busy}
                  onClick={() => {
                    setOpen(false)
                    setLinking(true)
                  }}
                >
                  更换邮箱
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!ready || busy}
                  onClick={unlink}
                >
                  <Unlink data-icon="inline-start" />
                  解除关联
                </Button>
              </div>
              {error ? <FieldError role="alert">{error}</FieldError> : null}
            </div>
          </PopoverContent>
        </Popover>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={!ready}
          onClick={() => setLinking(true)}
        >
          <Link2 data-icon="inline-start" />
          关联邮箱
        </Button>
      )}
      {linking ? (
        <LinkAccountMailboxDialog
          key={JSON.stringify([account.id, link?.mailboxId ?? null, link?.email ?? null])}
          account={account}
          onClose={() => setLinking(false)}
          onSaved={onChanged}
          {...(onPendingChange ? { onPendingChange } : {})}
        />
      ) : null}
      {ready && reader ? (
        <MailReader
          key={reader.scope}
          account={reader.account}
          onClose={() => setReader(null)}
        />
      ) : null}
    </>
  )
}
