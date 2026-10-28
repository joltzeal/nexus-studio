/**
 * Cross-page payloads that are not worth a store.
 *
 * The shell owns the handoff so a source can open an in-place dialog or navigate
 * to the AI page without coupling the two pages' component state.
 */
/** Public item metadata only; never credentials or model instructions. */
export interface GenerationSource {
  pluginId: string
  itemId: string
  title: string
  url: string
}

export interface AiImageHandoff {
  /** Defaults to the AI page; dialog keeps the source page mounted. */
  presentation?: 'page' | 'dialog'
  /** Remote picture URLs, in the order the source page showed them. */
  images: string[]
  /** Where the pictures came from, so the dialog can say so. */
  title: string
  source?: GenerationSource
  /** Editable product title/description, without automatically added directions. */
  initialPrompt?: string
}

type Listener = (payload: AiImageHandoff) => void

const listeners = new Set<Listener>()

/** The shell presents the requested editor and retains the payload until close. */
export function sendToAiImage(payload: AiImageHandoff): void {
  for (const listener of [...listeners]) listener(payload)
}

export function onAiImageHandoff(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
