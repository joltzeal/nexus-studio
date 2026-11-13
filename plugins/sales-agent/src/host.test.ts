import { describe, expect, it } from 'vitest'
import type { AgentScope } from '@nexus/plugin-sdk/agent'
import { HostChannel } from './host.js'

const scope: AgentScope = {
  batchId: '00000000-0000-4000-8000-000000000001',
  jobId: '00000000-0000-4000-8000-000000000002',
  windowId: '00000000-0000-4000-8000-000000000003',
  accountId: '00000000-0000-4000-8000-000000000004',
  leaseId: '00000000-0000-4000-8000-000000000005',
  fence: 1,
}

describe('full duplex host channel', () => {
  it('correlates host responses independently from plugin requests', async () => {
    const sent: Record<string, unknown>[] = []
    const channel = new HostChannel((message) => sent.push(message))
    const first = channel.call(scope, 'agent.action.get', { operationId: scope.jobId })
    const second = channel.call(scope, 'agent.checkpoint.get', { threadId: scope.jobId })
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({ type: 'host.request', hostVersion: 1, scope })
    channel.receive({
      type: 'host.response',
      hostVersion: 1,
      requestId: sent[1]?.requestId,
      ok: true,
      result: null,
    })
    channel.receive({
      type: 'host.response',
      hostVersion: 1,
      requestId: sent[0]?.requestId,
      ok: true,
      result: { state: 'confirmed' },
    })
    expect(await first).toEqual({ state: 'confirmed' })
    expect(await second).toBeNull()
    channel.close()
  })

  it('cancels promptly and ignores late results', async () => {
    const sent: Record<string, unknown>[] = []
    const channel = new HostChannel((message) => sent.push(message))
    const controller = new AbortController()
    const result = channel.call(scope, 'agent.browser.execute', {}, controller.signal)
    controller.abort()
    await expect(result).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(
      channel.receive({
        type: 'host.response',
        hostVersion: 1,
        requestId: sent[0]?.requestId,
        ok: true,
        result: { clicked: true },
      }),
    ).toBe(true)
    channel.close()
  })

  it('rejects all pending calls on shutdown without reporting success', async () => {
    const channel = new HostChannel(() => {})
    const pending = channel.call(scope, 'agent.artifact.read', {})
    channel.close()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(channel.call(scope, 'agent.action.get', {})).rejects.toMatchObject({
      code: 'CANCELLED',
    })
  })
})
