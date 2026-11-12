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
import { FieldError } from '@/components/ui/field'
import { toast } from '@/components/ui/toast'
import { removeMailbox } from './api'
import { useEmailAction } from './hooks'
import type { MailboxView } from './types'

export function RemoveMailboxDialog({
  account,
  onClose,
  onRemoved,
}: {
  account: MailboxView
  onClose: () => void
  onRemoved: () => void
}) {
  const { action, busy, error } = useEmailAction('邮箱删除失败，请重试。')
  function close() {
    action.dispose()
    onClose()
  }
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除邮箱？</AlertDialogTitle>
          <AlertDialogDescription className="break-all">
            将删除 {account.email} 的本地资料与凭据，停止后续刷新。远程邮箱中的邮件保留。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <FieldError>{error}</FieldError> : null}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={close}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(event) => {
              event.preventDefault()
              void action.run(
                () => removeMailbox(account.id),
                () => {
                  onRemoved()
                  toast.success('邮箱已删除')
                  close()
                },
              )
            }}
          >
            {busy ? '删除中…' : '删除'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
