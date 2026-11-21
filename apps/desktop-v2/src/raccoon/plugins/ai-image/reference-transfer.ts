import type { AiImageHandoff, GenerationSource } from './types'
import { uploadImage, uploadRemoteImage } from './api'
import { prepareReference } from './prepare-reference'
import type { PhotoMetadata } from './photo-metadata'
import { generationSource } from './source'
import type { StoredFile } from './types'

export interface InitialImage {
  url: string
  name: string
}

export const MAX_REFERENCES = 6

export interface ReferenceTransferDependencies {
  loadVintedImage: (itemId: string, url: string, signal: AbortSignal) => Promise<Blob>
}

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
  photoMetadata?: PhotoMetadata,
  dependencies?: ReferenceTransferDependencies,
): Promise<StoredFile> {
  signal.throwIfAborted()
  const validSource = source === undefined ? undefined : generationSource(source)
  if (validSource?.pluginId === 'studio.vinted-monitor') {
    if (!dependencies?.loadVintedImage)
      throw new Error('Vinted 参考图需要监控插件的受控图片传输入口。')
    const blob = await dependencies.loadVintedImage(validSource.itemId, image.url, signal)
    signal.throwIfAborted()
    const file = new File([blob], image.name, { type: blob.type })
    const prepared = await prepareReference(file, signal)
    signal.throwIfAborted()
    return photoMetadata === undefined
      ? uploadImage(prepared, signal)
      : uploadImage(prepared, signal, photoMetadata)
  }
  const stored =
    photoMetadata === undefined
      ? await uploadRemoteImage(image.url, image.name)
      : await uploadRemoteImage(image.url, image.name, photoMetadata)
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
