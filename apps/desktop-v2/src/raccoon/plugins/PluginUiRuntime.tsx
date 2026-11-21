import { useEffect } from 'react'
import { startPluginUiRuntime } from './ui-runtime'

export function PluginUiRuntime() {
  useEffect(() => startPluginUiRuntime(), [])
  useEffect(() => {
    let cancelled = false
    let stop: () => void = () => undefined
    void import('../../pages/plugins/ai-image/import-runtime').then((runtime) => {
      if (!cancelled) stop = runtime.startAutoProductImport()
    })
    return () => {
      cancelled = true
      stop()
    }
  }, [])
  return null
}
