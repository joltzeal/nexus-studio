import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createAgentServer } from './server.js'

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('sales Agent RPC', () => {
  it('requires handshake and advertises the browser capability', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const records: Record<string, unknown>[] = []
    output.on('data', (chunk: Buffer) => records.push(JSON.parse(chunk.toString())))
    const dispatch = vi.fn(async () => ({}))
    const server = createAgentServer({ input, output, dispatch })
    server.start()
    input.write(
      `${JSON.stringify({
        protocolVersion: 1,
        requestId: 'before',
        capability: 'sales.agent',
        method: 'salesAgent.settings.get',
        deadlineMs: 1000,
        payload: {},
      })}\n`,
    )
    await settle()
    expect(dispatch).not.toHaveBeenCalled()
    input.write('{"type":"handshake","protocolVersion":1}\n')
    await settle()
    expect(records.find((entry) => entry.type === 'ready')).toMatchObject({
      capabilities: ['sales.agent'],
    })
    server.stop()
  })

  it('continues reading host replies while a plugin request awaits a tool', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const records: Record<string, unknown>[] = []
    const scope = {
      batchId: '00000000-0000-4000-8000-000000000001',
      jobId: '00000000-0000-4000-8000-000000000002',
      windowId: '00000000-0000-4000-8000-000000000003',
      accountId: '00000000-0000-4000-8000-000000000004',
      leaseId: '00000000-0000-4000-8000-000000000005',
      fence: 1,
    }
    const server = createAgentServer({
      input,
      output,
      dispatch: async (context, host) =>
        host.call(scope, 'agent.action.get', {}, context.signal),
    })
    output.on('data', (chunk: Buffer) => {
      const record = JSON.parse(chunk.toString()) as Record<string, unknown>
      records.push(record)
      if (record.type === 'host.request')
        input.write(
          `${JSON.stringify({
            type: 'host.response',
            hostVersion: 1,
            requestId: record.requestId,
            ok: true,
            result: { state: 'confirmed' },
          })}\n`,
        )
    })
    server.start()
    input.write('{"type":"handshake","protocolVersion":1}\n')
    input.write(
      `${JSON.stringify({
        protocolVersion: 1,
        requestId: 'step',
        capability: 'sales.agent',
        method: 'salesAgent.jobs.step',
        deadlineMs: 1000,
        payload: {},
      })}\n`,
    )
    await settle()
    expect(records.find((entry) => entry.requestId === 'step')).toMatchObject({
      ok: true,
      result: { state: 'confirmed' },
    })
    server.stop()
  })
})
