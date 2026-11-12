import { useState } from 'react'
import { Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LinkMailboxAccountDialog } from './link-account-dialog'
import type { MailboxView } from './types'

export function EmailAccountLink({
  mailbox,
  disabled = false,
}: {
  mailbox: MailboxView
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`关联 ${mailbox.email} 到账号`}
        title="关联账号"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Link2 />
      </Button>
      {open ? (
        <LinkMailboxAccountDialog
          key={JSON.stringify([mailbox.id, mailbox.email])}
          mailbox={mailbox}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
