import {
  listPlugins,
  pluginHostAvailable,
  type PluginView,
} from '@/lib/platform/native-plugins'
import { onPluginCatalogChanged } from '@/lib/platform/plugin-catalog-events'

export function watchPluginCatalog(
  onCatalog: (plugins: PluginView[]) => void,
  onError: () => void,
): () => void {
  if (!pluginHostAvailable()) return () => {}
  let active = true
  let pending = false
  let revision = 0

  async function read() {
    const requestedRevision = revision
    pending = true
    try {
      const catalog = await listPlugins()
      if (active && requestedRevision === revision) onCatalog(catalog)
    } catch {
      if (active && requestedRevision === revision) onError()
    } finally {
      pending = false
      if (active && requestedRevision !== revision) void read()
    }
  }

  function refresh() {
    revision += 1
    if (!pending) void read()
  }

  const unsubscribe = onPluginCatalogChanged(refresh)
  const timer = setInterval(() => {
    // Slow reads must be allowed to settle; only mutations invalidate a snapshot.
    if (!pending) refresh()
  }, 5000)
  refresh()
  return () => {
    active = false
    clearInterval(timer)
    unsubscribe()
  }
}
