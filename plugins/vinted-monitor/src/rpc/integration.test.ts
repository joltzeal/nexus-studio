import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createVintedMonitorPlugin } from '../index.js'

describe('public plugin RPC', () => {
  it('validates the manifest and serves the camelCase contract through the real protocol loop', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const diagnostics = new PassThrough()
    const messages: Record<string, unknown>[] = []
    output.on('data', (data: Buffer) => {
      for (const line of data.toString().trim().split('\n'))
        messages.push(JSON.parse(line) as Record<string, unknown>)
    })
    const instance = createVintedMonitorPlugin({ input, output, diagnostics })
    instance.server.start()
    input.write(`${JSON.stringify({ type: 'handshake', protocolVersion: 1 })}\n`)
    const request = async (requestId: string, method: string, payload: unknown) => {
      input.write(
        `${JSON.stringify({ protocolVersion: 1, requestId, capability: 'monitor.collector', method, payload, deadlineMs: 10_000 })}\n`,
      )
      for (let i = 0; i < 100; i++) {
        const message = messages.find((m) => m.requestId === requestId)
        if (message) return message
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      throw new Error('Missing RPC result')
    }
    try {
      expect(messages.find((m) => m.type === 'ready')).toMatchObject({
        methods: expect.arrayContaining([
          'vinted.items.monitorSeller',
          'vinted.proxies.default',
          'vinted.image.open',
        ]),
      })
      expect(
        await request('empty', 'vinted.items.list', { page: 0, pageSize: 20 }),
      ).toMatchObject({
        ok: true,
        result: { items: [], total: 0, totalPages: 0, page: 0, pageSize: 20 },
      })
      const proxy = await request('proxy', 'vinted.proxies.save', {
        name: 'P',
        scheme: 'http',
        host: 'localhost',
        port: 3128,
        username: 'test',
        password: 'never-echo-this',
        enabled: true,
      })
      expect(proxy).toMatchObject({
        ok: true,
        result: { created: true, item: { hasPassword: true } },
      })
      expect(JSON.stringify(messages)).not.toContain('never-echo-this')
      expect(
        await request('invalid', 'vinted.proxies.save', {
          name: 'bad',
          scheme: 'http',
          host: 'http://test:never-echo-this@localhost',
          port: 1,
          username: '',
          enabled: true,
        }),
      ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
      expect(JSON.stringify(messages)).not.toContain('never-echo-this')
    } finally {
      instance.stop()
      input.destroy()
      output.destroy()
      diagnostics.destroy()
    }
  })
})
