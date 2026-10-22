/**
 * Cross-page payloads that are not worth a store.
 *
 * A page cannot reach into another page's props: the shell renders one tab at a
 * time and the source unmounts as soon as the target mounts. This module is the
 * smallest thing that survives that handover — a send that fires immediately and
 * a listener the shell keeps for its whole life.
 */
export interface AiImageHandoff {
  /** Remote picture URLs, in the order the source page showed them. */
  images: string[]
  /** Where the pictures came from, so the dialog can say so. */
  title: string
}

type Listener = (payload: AiImageHandoff) => void

const listeners = new Set<Listener>()

/** The shell switches pages; the AI page reads the payload from its props. */
export function sendToAiImage(payload: AiImageHandoff): void {
  for (const listener of [...listeners]) listener(payload)
}

export function onAiImageHandoff(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
