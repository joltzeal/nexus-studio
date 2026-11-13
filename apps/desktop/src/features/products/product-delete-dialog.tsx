import { useEffect, useRef, useState } from 'react'
import type { ProductSummary } from '@nexus/plugin-products/contracts'
import { Loader2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { removeProduct } from './api'
import { productError } from './product-form'

export function ProductDeleteDialog({
  product,
  onClose,
  onDeleted,
}: {
  product: ProductSummary
  onClose: () => void
  onDeleted: (id: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  async function remove() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      await removeProduct({ id: product.id, revision: product.revision })
      if (active.current) onDeleted(product.id)
    } catch (cause) {
      if (active.current) setError(productError(cause))
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending.current) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除商品</AlertDialogTitle>
          <AlertDialogDescription>
            确认删除「{product.name}」及其商品图片吗？此操作不能撤销，不会删除 AI
            生图原记录。 若商品已被其他操作修改，删除会被阻止，请刷新核对后重试。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>商品删除失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(event) => {
              event.preventDefault()
              void remove()
            }}
          >
            {busy && <Loader2 data-icon="inline-start" className="animate-spin" />}
            {busy ? '删除中…' : '删除商品'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
