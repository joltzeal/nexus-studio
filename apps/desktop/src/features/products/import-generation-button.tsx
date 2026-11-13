import { useEffect, useRef, useState } from 'react'
import { Loader2, PackagePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toast'
import { importGenerationProduct, type AiProductImportProgress } from './ai-import'

export function ImportGenerationButton({
  recordId,
  disabled,
  onBusyChange,
}: {
  recordId: string
  disabled: boolean
  onBusyChange: (busy: boolean) => void
}) {
  const [progress, setProgress] = useState<AiProductImportProgress | null>(null)
  const current = useRef<AbortController | null>(null)

  useEffect(() => () => current.current?.abort(), [])

  async function importProduct() {
    if (current.current) return
    const controller = new AbortController()
    current.current = controller
    onBusyChange(true)
    try {
      const result = await importGenerationProduct(recordId, {
        signal: controller.signal,
        onProgress: (next) => {
          if (current.current === controller && !controller.signal.aborted)
            setProgress(next)
        },
      })
      if (!controller.signal.aborted)
        toast.success(
          result.alreadyImported
            ? '该批次已在商品库中，保留现有资料。'
            : '已导入商品库，可继续补充商品资料。',
        )
    } catch (error) {
      if (!controller.signal.aborted)
        toast.error(error instanceof Error ? error.message : '导入失败，请稍后重试。')
    } finally {
      if (current.current === controller && !controller.signal.aborted) {
        current.current = null
        setProgress(null)
        onBusyChange(false)
      }
    }
  }

  const label =
    progress?.stage === 'copying'
      ? `复制图片 ${progress.completed + 1}/${progress.total}`
      : progress?.stage === 'saving'
        ? '正在保存商品'
        : '导入商品库'

  return (
    <Button
      type="button"
      variant="outline"
      disabled={disabled || progress !== null}
      title="将整组图片和文案复制到商品库"
      onClick={() => void importProduct()}
    >
      {progress === null ? (
        <PackagePlus data-icon="inline-start" />
      ) : (
        <Loader2 data-icon="inline-start" className="animate-spin" />
      )}
      {label}
    </Button>
  )
}
