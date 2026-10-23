const listeners = new Set<() => void>()

export function onPluginCatalogChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifyPluginCatalogChanged(): void {
  for (const listener of listeners) listener()
}
