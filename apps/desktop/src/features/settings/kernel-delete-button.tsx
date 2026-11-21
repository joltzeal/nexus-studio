import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { browserError } from '@/lib/platform/browser-api'

export function KernelDeleteButton({
  version,
  disabled,
  onDelete,
}: {
  version: string
  disabled?: boolean
  onDelete: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          setOpen(next)
          if (!next) setError(null)
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled}>
          删除
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除内核 {version}？</AlertDialogTitle>
          <AlertDialogDescription>
            删除本机下载文件。仍有窗口绑定该版本时会阻止删除。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <FieldError role="alert">{error}</FieldError> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault()
              setPending(true)
              setError(null)
              void onDelete()
                .then(
                  () => setOpen(false),
                  (cause: unknown) => setError(browserError(cause).message),
                )
                .finally(() => setPending(false))
            }}
          >
            {pending ? '正在删除…' : '确认删除'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
