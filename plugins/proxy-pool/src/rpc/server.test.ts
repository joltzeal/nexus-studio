import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import manifest from '../../nexus.plugin.js'
import { cancelled } from '../domain/errors.js'
import type { Dispatch, DispatchContext } from './protocol.js'
import { createLogger, Redactor } from './redact.js'
import { createPluginServer } from './server.js'

interface Harness {
  send(message: unknown): void
  raw(text: string): void
  messages: Record<string, unknown>[]
  logs: string[]
  waitFor(count: number): Promise<void>
  redactor: Redactor
  stop(): void
}

function harness(dispatch: Dispatch, methods: string[] = ['proxy.list']): Harness {
  const input = new PassThrough()
  const output = new PassThrough()
  const messages: Record<string, unknown>[] = []
  const logs: string[] = []
  const waiters: Array<{ count: number; resolve: () => void }> = []
  const redactor = new Redactor()
  const logger = createLogger((line) => logs.push(line), redactor)

  let buffer = ''
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line !== '') messages.push(JSON.parse(line) as Record<string, unknown>)
      index = buffer.indexOf('\n')
    }
    for (const waiter of [...waiters]) {
      if (messages.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
  })

  const server = createPluginServer({
    input,
    output,
    manifest,
    methods,
    dispatch,
    logger,
    status: () => ({ storage: { kind: 'memory', durable: false } }),
    maxProtocolErrors: 99,
  })
  server.start()

  return {
    send(message) {
      input.write(`${JSON.stringify(message)}\n`)
    },
    raw(text) {
      input.write(text)
    },
    messages,
    logs,
    redactor,
    stop: () => server.stop(),
    waitFor(count) {
      if (messages.length >= count) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`等待第 ${count} 条消息超时`)),
          3000,
        )
        waiters.push({
          count,
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
        })
      })
    },
  }
}

const handshake = { type: 'handshake', protocolVersion: 1 }

function request(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    requestId: 'req-1',
    capability: 'proxy.provider',
    method: 'proxy.list',
    deadlineMs: 1000,
    payload: {},
    ...overrides,
  }
}

describe('plugin protocol', () => {
  it('announces identity before any call', async () => {
    const test = harness(async () => ({ ok: true }))
    await test.waitFor(1)
    expect(test.messages[0]).toMatchObject({
      type: 'hello',
      pluginId: 'studio.proxy-pool',
      capabilities: ['proxy.provider'],
    })
  })

  it('answers a handshake with the declared methods and status', async () => {
    const test = harness(async () => ({ ok: true }))
    test.send(handshake)
    await test.waitFor(2)
    expect(test.messages[1]).toMatchObject({
      type: 'ready',
      methods: ['proxy.list'],
      status: { storage: { durable: false } },
    })
  })

  it('refuses calls before the handshake completes', async () => {
    const test = harness(async () => ({ ok: true }))
    test.send(request())
    await test.waitFor(2)
    expect(test.messages[1]).toMatchObject({
      ok: false,
      error: { code: 'PROTOCOL_ERROR' },
    })
  })

  it('denies an undeclared capability and an unknown method', async () => {
    const test = harness(async () => ({ ok: true }))
    test.send(handshake)
    test.send(request({ requestId: 'a', capability: 'image.provider' }))
    test.send(request({ requestId: 'b', method: 'proxy.launch-browser' }))
    await test.waitFor(4)
    expect(test.messages[2]).toMatchObject({ error: { code: 'PERMISSION_DENIED' } })
    expect(test.messages[3]).toMatchObject({ error: { code: 'INVALID_REQUEST' } })
  })

  it('rejects a repeated requestId so a result cannot apply twice', async () => {
    let calls = 0
    const test = harness(async () => {
      calls += 1
      return { calls }
    })
    test.send(handshake)
    test.send(request({ requestId: 'dup' }))
    await test.waitFor(3)
    test.send(request({ requestId: 'dup' }))
    await test.waitFor(4)
    expect(test.messages[2]).toMatchObject({ ok: true, result: { calls: 1 } })
    expect(test.messages[3]).toMatchObject({ error: { code: 'PROTOCOL_ERROR' } })
    expect(calls).toBe(1)
  })

  it('returns TIMEOUT at the deadline and discards the late result', async () => {
    const test = harness(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ late: true }), 120)
        }),
    )
    test.send(handshake)
    test.send(request({ requestId: 'slow', deadlineMs: 30 }))
    await test.waitFor(3)
    expect(test.messages[2]).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(test.messages).toHaveLength(3)
    expect(test.logs.join('')).toContain('丢弃迟到结果')
  })

  it('reports CANCELLED and lets the handler observe it', async () => {
    const seen: string[] = []
    const test = harness(async (context) => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      try {
        context.assertAlive()
        seen.push('alive')
      } catch (error) {
        seen.push(error instanceof Error ? error.message : 'failed')
        throw cancelled()
      }
      return { ok: true }
    })
    test.send(handshake)
    test.send(request({ requestId: 'cancel-me', deadlineMs: 2000 }))
    test.send({ type: 'cancel', requestId: 'cancel-me' })
    await test.waitFor(3)
    expect(test.messages[2]).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(seen).toEqual(['调用已取消'])
    expect(test.messages).toHaveLength(3)
  })

  it('rejects an oversized message before parsing it', async () => {
    const test = harness(async () => ({ ok: true }))
    test.send(handshake)
    test.raw(`${'x'.repeat(1024 * 1024 + 10)}\n`)
    await test.waitFor(3)
    expect(test.messages[2]).toMatchObject({
      error: { code: 'PROTOCOL_ERROR', message: '消息超过大小上限' },
    })
  })

  it('rejects malformed JSON without leaking the payload', async () => {
    const test = harness(async () => ({ ok: true }))
    test.send(handshake)
    test.raw('{"protocolVersion":1,"password":"p@ssw0rd"\n')
    await test.waitFor(3)
    expect(JSON.stringify(test.messages[2])).not.toContain('p@ssw0rd')
  })

  it('maps a capability failure to its stable code', async () => {
    const test = harness(async () => {
      throw new Error('boom at proxy.example:1080 with p@ssw0rd')
    })
    // The vault registers resolved secrets, which is what makes redaction work.
    test.redactor.add('p@ssw0rd')
    test.send(handshake)
    test.send(request({ requestId: 'fail' }))
    await test.waitFor(3)
    expect(test.messages[2]).toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE', message: '插件执行失败' },
    })
    expect(JSON.stringify(test.messages[2])).not.toContain('p@ssw0rd')
    expect(test.logs.join('')).not.toContain('p@ssw0rd')
  })

  it('redacts registered secrets from diagnostics', async () => {
    const test = harness(async () => {
      throw new Error('failed with p@ssw0rd at socks5://user:p@ssw0rd@proxy.example:1080')
    })
    test.redactor.add('p@ssw0rd')
    test.send(handshake)
    test.send(request({ requestId: 'redact' }))
    await test.waitFor(3)
    const logs = test.logs.join('')
    expect(logs).not.toContain('p@ssw0rd')
    expect(logs).toContain('[REDACTED]')
  })
})

describe('dispatch contract', () => {
  it('passes the deadline and method through to the handler', async () => {
    const handler = vi.fn(async (context: DispatchContext) => ({
      ok: true,
      method: context.method,
    }))
    const test = harness(handler)
    test.send(handshake)
    test.send(request({ method: 'proxy.list', payload: { keyword: 'x' } }))
    await test.waitFor(3)
    expect(handler).toHaveBeenCalledTimes(1)
    const context = handler.mock.calls[0]?.[0]
    expect(context?.method).toBe('proxy.list')
    expect(context?.payload).toEqual({ keyword: 'x' })
    expect(context?.deadlineAt).toBeGreaterThan(Date.now())
  })
})
