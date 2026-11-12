import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import manifest from '../../nexus.plugin.js'
import { createPluginServer } from './server.js'
import type { PluginResponse } from './protocol.js'

function harness(
  dispatch: Parameters<typeof createPluginServer>[0]['dispatch'],
  methods = ['email.test'],
) {
  const input = new PassThrough()
  const output = new PassThrough()
  const logs: string[] = []
  const messages: PluginResponse[] = []
  output.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n'))
      messages.push(JSON.parse(line) as PluginResponse)
  })
  const server = createPluginServer({
    input,
    output,
    manifest,
    dispatch,
    methods,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error: (message, fields) => logs.push(JSON.stringify([message, fields])),
    },
    status: () => ({ storageDurable: true }),
  })
  server.start()
  input.write('{"type":"handshake","protocolVersion":1}\n')
  return {
    input,
    server,
    messages,
    logs,
    request(payload: unknown = {}, deadlineMs = 1000) {
      input.write(
        `${JSON.stringify({
          protocolVersion: 1,
          requestId: 'test-request',
          capability: 'email.provider',
          method: 'email.test',
          payload,
          deadlineMs,
        })}\n`,
      )
    },
    close() {
      server.stop()
      input.destroy()
      output.destroy()
    },
  }
}

describe('mailbox RPC boundary', () => {
  it('rejects oversized output without writing a protocol-breaking line', async () => {
    const t = harness(async () => ({ body: 'x'.repeat(1024 * 1024) }))
    try {
      t.request()
      await vi.waitFor(() => expect(t.messages).toHaveLength(3))
      expect(t.messages[2]).toMatchObject({
        ok: false,
        error: { code: 'UNAVAILABLE' },
      })
      expect(JSON.stringify(t.messages[2]).length).toBeLessThan(1024 * 1024)
    } finally {
      t.close()
    }
  })

  it('never logs raw exceptions that could contain mailbox credentials', async () => {
    const t = harness(async () => {
      throw new Error('synthetic-private-value-from-transport')
    })
    try {
      t.request()
      await vi.waitFor(() => expect(t.messages).toHaveLength(3))
      expect(JSON.stringify(t.messages)).not.toContain('synthetic-private-value')
      expect(t.logs.join('')).not.toContain('synthetic-private-value')
    } finally {
      t.close()
    }
  })

  it.each(['cancel', 'deadline', 'stop'])(
    'cancels a mailbox request on %s',
    async (mode) => {
      let captured: AbortSignal | undefined
      const t = harness(
        ({ signal }) =>
          new Promise<never>((_resolve, reject) => {
            captured = signal
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
      )
      try {
        t.request({}, mode === 'deadline' ? 20 : 1000)
        await vi.waitFor(() => expect(captured).toBeDefined())
        if (mode === 'cancel')
          t.input.write('{"type":"cancel","requestId":"test-request"}\n')
        else if (mode === 'stop') t.server.stop()
        await vi.waitFor(() => expect(captured?.aborted).toBe(true))
      } finally {
        t.close()
      }
    },
  )
})
