import type { MarketEntry, PluginView } from '@/lib/platform/native-plugins'

export function pendingPluginUpdates(
  entries: MarketEntry[],
  plugins: PluginView[],
  licensedPluginIds: ReadonlySet<string>,
): MarketEntry[] {
  const installed = new Set(
    plugins
      .filter((plugin) => plugin.state !== 'available' && plugin.state !== 'unlicensed')
      .map((plugin) => plugin.id),
  )
  return entries.filter(
    (entry) =>
      entry.state === 'update' &&
      installed.has(entry.id) &&
      licensedPluginIds.has(entry.id),
  )
}

export async function installPendingUpdates(
  candidates: MarketEntry[],
  install: (id: string) => Promise<unknown>,
  onProgress: (entry: MarketEntry, index: number, total: number) => void,
): Promise<{ updated: number; failures: { entry: MarketEntry; error: unknown }[] }> {
  const failures: { entry: MarketEntry; error: unknown }[] = []
  for (const [index, entry] of candidates.entries()) {
    onProgress(entry, index + 1, candidates.length)
    try {
      await install(entry.id)
    } catch (error) {
      failures.push({ entry, error })
    }
  }
  return { updated: candidates.length - failures.length, failures }
}
