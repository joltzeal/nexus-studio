import type { AiImageHandoff, GenerationSource } from '@/lib/page-handoff'
import { loadVintedImage } from '@/features/vinted-monitor/api'
import { uploadImage, uploadRemoteImage } from './api'
import { generationSource } from './source'
import type { StoredFile } from './types'

export interface InitialImage {
  url: string
  name: string
}

export const MAX_REFERENCES = 6

export function handoffImages(handoff: AiImageHandoff | null): InitialImage[] {
  if (handoff === null) return []
  const title = handoff.title.trim().slice(0, 100) || '商品图'
  // Preserve the exact gallery selection and ordering, including overflow so the
  // user can explicitly remove it instead of submitting a silently smaller set.
  return handoff.images.map((url, index) => ({
    url,
    name: `${title}-${String(index + 1)}`,
  }))
}

export async function transferInitialImage(
  image: InitialImage,
  source: GenerationSource | undefined,
  signal: AbortSignal,
): Promise<StoredFile> {
  signal.throwIfAborted()
  const validSource = source === undefined ? undefined : generationSource(source)
  if (validSource?.pluginId === 'studio.vinted-monitor') {
    const blob = await loadVintedImage(validSource.itemId, image.url, signal)
    signal.throwIfAborted()
    // File wraps the original bytes. Do not decode, resize or re-encode them.
    const file = new File([blob], image.name, { type: blob.type })
    return uploadImage(file, signal)
  }
  const stored = await uploadRemoteImage(image.url, image.name)
  signal.throwIfAborted()
  return stored
}

/** Removing, retrying or unmounting invalidates that attempt's async callbacks. */
export class ReferenceTransfers {
  private readonly pending = new Map<string, AbortController>()

  async start(
    key: string,
    transfer: (signal: AbortSignal) => Promise<StoredFile>,
    ready: (file: StoredFile) => void,
    failed: (error: unknown) => void,
  ): Promise<void> {
    this.cancel(key)
    const controller = new AbortController()
    this.pending.set(key, controller)
    try {
      const file = await transfer(controller.signal)
      if (!controller.signal.aborted) ready(file)
    } catch (error) {
      if (!controller.signal.aborted) failed(error)
    } finally {
      if (this.pending.get(key) === controller) this.pending.delete(key)
    }
  }

  cancel(key: string): void {
    this.pending.get(key)?.abort()
    this.pending.delete(key)
  }

  cancelAll(): void {
    for (const key of this.pending.keys()) this.cancel(key)
  }
}
