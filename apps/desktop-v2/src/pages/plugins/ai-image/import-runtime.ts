import { isNativeRaccoon } from '../../../raccoon/runtime'
import { getRecord } from '../../../raccoon/plugins/ai-image/api'
import { AutoProductImport } from '../../../raccoon/plugins/ai-image/auto-product-import'
import { importGenerationProduct } from '../../../raccoon/plugins/ai-image/product-import'
import { toast, useToastStore } from '../../../shared/model/toast'

let runtime: AutoProductImport | null = null

function importer() {
  runtime ??= new AutoProductImport({
    storage: localStorage,
    getRecord,
    importProduct: importGenerationProduct,
    notify: (title, retry) => {
      if (retry)
        useToastStore.getState().push(
          {
            kind: 'warn',
            title,
            persistent: true,
            action: { label: '重试入库', run: retry },
          },
          null,
        )
      else toast.ok(title)
    },
  })
  return runtime
}

export function trackGeneratedProduct(recordId: string) {
  importer().track(recordId)
  void importer().check()
}

export function startAutoProductImport() {
  if (!isNativeRaccoon()) return () => undefined
  const check = () => {
    try {
      void importer().check()
    } catch (cause) {
      toast.err(cause instanceof Error ? cause.message : '自动入库待办读取失败')
    }
  }
  check()
  const timer = setInterval(check, 3000)
  return () => clearInterval(timer)
}
