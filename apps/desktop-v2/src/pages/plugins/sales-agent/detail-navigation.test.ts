import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  consumeDetailNavigation,
  cancelDetailNavigation,
  failDetailNavigation,
  cancelUnavailableDetailNavigation,
  pendingDetailNavigation,
  navigateDetail,
  parseAgentDeepLink,
  watchDetailNavigation,
  type DetailNavigation,
} from '../../../raccoon/plugins/detail-navigation'

const id = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'

describe('business detail navigation', () => {
  it('finishes a failed navigation once without letting catalog refresh replay it', () => {
    navigateDetail({ kind: 'window', id })
    const intent = pendingDetailNavigation()!
    const report = vi.fn()
    failDetailNavigation(intent.intentId, report)
    expect(pendingDetailNavigation()).toBeNull()
    const replay = vi.fn()
    const stop = watchDetailNavigation(replay)
    expect(replay).not.toHaveBeenCalled()
    failDetailNavigation(intent.intentId, report)
    expect(report).toHaveBeenCalledOnce()
    stop()
  })

  it('does not report stale failures or cancel a newer destination intent', () => {
    navigateDetail({ kind: 'window', id })
    const earlier = pendingDetailNavigation()!
    navigateDetail({ kind: 'agent', id: other })
    const report = vi.fn()
    failDetailNavigation(earlier.intentId, report)
    expect(report).not.toHaveBeenCalled()
    expect(pendingDetailNavigation()?.request.id).toBe(other)
  })

  beforeEach(() => {
    cancelDetailNavigation()
    for (const kind of ['product', 'account', 'window', 'agent'] as const)
      consumeDetailNavigation(kind)
  })

  it('keeps a request for a destination that has not mounted yet and consumes it once', () => {
    navigateDetail({ kind: 'product', id })
    const shell = vi.fn()
    const stop = watchDetailNavigation(shell)
    expect(shell).toHaveBeenCalledWith({ kind: 'product', id })
    expect(consumeDetailNavigation('account')).toBeNull()
    expect(consumeDetailNavigation('product')).toEqual({ kind: 'product', id })
    expect(consumeDetailNavigation('product')).toBeNull()
    stop()
  })

  it('notifies the shell and replaces stale destination requests', () => {
    const shell = vi.fn()
    const stop = watchDetailNavigation(shell)
    navigateDetail({ kind: 'product', id })
    navigateDetail({ kind: 'agent', id: other, batchId: other })
    expect(shell).toHaveBeenCalledTimes(2)
    expect(consumeDetailNavigation('product')).toBeNull()
    expect(consumeDetailNavigation('agent')?.batchId).toBe(other)
    stop()
    navigateDetail({ kind: 'window', id })
    expect(shell).toHaveBeenCalledTimes(2)
  })

  it('preserves a source relation when navigating to its execution history', () => {
    navigateDetail({ kind: 'agent', id, related: 'product' })
    expect(consumeDetailNavigation('agent')).toEqual({
      kind: 'agent',
      id,
      related: 'product',
    })
    expect(() =>
      navigateDetail({
        kind: 'product',
        id,
        related: 'account',
      } as unknown as DetailNavigation),
    ).toThrow()
  })

  it('cancels an abandoned gated detail without replaying it on a later visit', () => {
    navigateDetail({ kind: 'agent', id, related: 'account' })
    const intent = pendingDetailNavigation()
    expect(intent?.request.related).toBe('account')
    cancelDetailNavigation(intent!.intentId)
    const destination = vi.fn()
    const stop = watchDetailNavigation(destination)
    expect(destination).not.toHaveBeenCalled()
    expect(consumeDetailNavigation('agent')).toBeNull()
    stop()
  })

  it('does not let an older intent cancellation erase a newer destination', () => {
    navigateDetail({ kind: 'agent', id })
    const abandoned = pendingDetailNavigation()!
    navigateDetail({ kind: 'product', id: other })
    cancelDetailNavigation(abandoned.intentId)
    expect(consumeDetailNavigation('product')?.id).toBe(other)
  })

  it('clears an unavailable destination while retaining a still-enabled gated plugin', () => {
    navigateDetail({ kind: 'agent', id })
    cancelUnavailableDetailNavigation(new Set(['plugin:studio.sales-agent']))
    expect(pendingDetailNavigation()).not.toBeNull()
    cancelUnavailableDetailNavigation(new Set(['profiles', 'plugins']))
    expect(pendingDetailNavigation()).toBeNull()
    expect(consumeDetailNavigation('agent')).toBeNull()
  })

  it('accepts only a read-only batch navigation link and rejects arbitrary link payloads', () => {
    expect(parseAgentDeepLink(`nexus://agent/${id}`)).toEqual({
      kind: 'agent',
      id,
      batchId: id,
    })
    for (const url of [
      `https://agent/${id}`,
      `nexus://user:secret@agent/${id}`,
      `nexus://agent/${id}?action=publish`,
      `nexus://agent/${id}#secret`,
      'nexus://agent/not-a-uuid',
      `nexus://agent/${id}/other`,
      `nexus://agent/%2f${id}`,
    ])
      expect(parseAgentDeepLink(url)).toBeNull()
  })
})
