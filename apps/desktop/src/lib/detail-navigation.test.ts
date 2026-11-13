import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  consumeDetailNavigation,
  navigateDetail,
  parseAgentDeepLink,
  watchDetailNavigation,
  type DetailNavigation,
} from './detail-navigation'

const id = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'

describe('business detail navigation', () => {
  beforeEach(() => {
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
