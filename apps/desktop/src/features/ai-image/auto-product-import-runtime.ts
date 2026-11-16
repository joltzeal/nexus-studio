import { toast } from '@/components/ui/toast'
import { importGenerationProduct } from '@/features/products/ai-import'
import { getRecord } from './api'
import { AutoProductImport } from './auto-product-import'

let runtime: AutoProductImport | null = null

function importer(): AutoProductImport {
  runtime ??= new AutoProductImport({
    storage: localStorage,
    getRecord,
    importProduct: importGenerationProduct,
    notify: (message, retry) => {
      if (retry)
        toast.info(message, {
          duration: 0,
          action: { label: '重试入库', onClick: retry },
        })
      else toast.success(message)
    },
  })
  return runtime
}

export function trackGeneratedProduct(recordId: string): void {
  importer().track(recordId)
  void importer().check()
}

export function startAutoProductImport(): () => void {
  if (typeof localStorage === 'undefined') return () => undefined
  const check = () => void importer().check()
  check()
  const timer = setInterval(check, 3000)
  return () => clearInterval(timer)
}
