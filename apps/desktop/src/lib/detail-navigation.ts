import { useEffect } from 'react'
import { AgentScopeSchema } from '@nexus/plugin-sdk/agent'

export interface DetailNavigation {
  kind: 'product' | 'account' | 'window' | 'agent'
  id: string
  batchId?: string
  related?: 'product' | 'account' | 'window'
}
const uuid = AgentScopeSchema.shape.batchId
type Listener = (request: DetailNavigation) => void
const listeners = new Set<Listener>()
let pending: DetailNavigation | null = null

export function navigateDetail(request: DetailNavigation): void {
  if (
    !['product', 'account', 'window', 'agent'].includes(request.kind) ||
    !uuid.safeParse(request.id).success ||
    (request.batchId !== undefined && !uuid.safeParse(request.batchId).success) ||
    (request.related !== undefined &&
      (request.kind !== 'agent' ||
        !['product', 'account', 'window'].includes(request.related)))
  )
    throw new Error('无法打开无效的业务记录。')
  const parsed = { ...request }
  pending = parsed
  for (const listener of [...listeners]) listener(parsed)
}

export function watchDetailNavigation(listener: Listener): () => void {
  listeners.add(listener)
  if (pending) listener(pending)
  return () => {
    listeners.delete(listener)
  }
}

export function consumeDetailNavigation(
  kind: DetailNavigation['kind'],
): DetailNavigation | null {
  if (pending?.kind !== kind) return null
  const value = pending
  pending = null
  return value
}

export function useDetailNavigation(
  kind: DetailNavigation['kind'],
  listener: Listener,
): void {
  useEffect(
    () =>
      watchDetailNavigation((request) => {
        if (request.kind !== kind) return
        const value = consumeDetailNavigation(kind)
        if (value) listener(value)
      }),
    [kind, listener],
  )
}

export function parseAgentDeepLink(raw: string): DetailNavigation | null {
  try {
    if (raw.length > 200 || /[\s\\]/u.test(raw)) return null
    const url = new URL(raw)
    if (
      url.protocol !== 'nexus:' ||
      url.hostname !== 'agent' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null
    const id = url.pathname.slice(1)
    if (!uuid.safeParse(id).success) return null
    return { kind: 'agent', id, batchId: id }
  } catch {
    return null
  }
}
