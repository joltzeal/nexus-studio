import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWindowSyncPlugin } from './index.js'

let directory: string
const instances: ReturnType<typeof createWindowSyncPlugin>[] = []

function host() {
  const input = new PassThrough()
  const output = new PassThrough()
  const diagnostics = new PassThrough()
  const messages: Record<string, unknown>[] = []
  let pending = ''
  let logs = ''
  output.on('data', (chunk: Buffer) => {
    pending += chunk.toString()
    for (;;) {
      const index = pending.indexOf('\n')
      if (index === -1) break
      messages.push(JSON.parse(pending.slice(0, index)) as Record<string, unknown>)
      pending = pending.slice(index + 1)
    }
  })
  diagnostics.on('data', (chunk: Buffer) => {
    logs += chunk.toString()
  })
  const instance = createWindowSyncPlugin({ input, output, diagnostics })
  instances.push(instance)
  instance.server.start()
  const send = (value: unknown): void => {
    input.write(`${JSON.stringify(value)}\n`)
  }
  const take = async (predicate: (message: Record<string, unknown>) => boolean) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const index = messages.findIndex(predicate)
      if (index !== -1) return messages.splice(index, 1)[0]!
      await delay(5)
    }
    throw new Error('No protocol response')
  }
  const call = (
    id: string,
    method: string,
    payload: unknown,
    capability = 'window.sync',
    deadlineMs = 5000,
  ) => {
    send({ protocolVersion: 1, requestId: id, capability, method, payload, deadlineMs })
    return take((message) => message['requestId'] === id)
  }
  return { input, send, take, call, instance, messages, logs: () => logs }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nexus-sync-rpc-'))
})

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.server.stop()))
  await rm(directory, { recursive: true, force: true })
})

describe('window.sync host protocol', () => {
  it('announces the exact methods through the existing hello/handshake/ready envelopes', async () => {
    const peer = host()
    expect(await peer.take((message) => message['type'] === 'hello')).toMatchObject({
      type: 'hello',
      protocolVersion: 1,
      pluginId: 'studio.window-sync',
      apiVersion: 1,
      version: '1.0.0',
      capabilities: ['window.sync'],
    })
    peer.send({ type: 'handshake', protocolVersion: 1 })
    expect(await peer.take((message) => message['type'] === 'ready')).toMatchObject({
      type: 'ready',
      methods: ['sync.offer', 'sync.receive', 'sync.status', 'sync.cancel'],
    })
    expect((await peer.call('unknown', 'sync.status', { id: 'no-job' }))['ok']).toBe(
      false,
    )
  })

  it('blocks calls before handshake, unauthorized capabilities, unknown fields and methods', async () => {
    const peer = host()
    const early = await peer.call('early', 'sync.status', { id: 'any' })
    expect(early['ok']).toBe(false)
    peer.send({ type: 'handshake', protocolVersion: 1 })
    expect(await peer.call('cap', 'sync.offer', {}, 'proxy.provider')).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    })
    expect(await peer.call('method', 'sync.export', {})).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    })
    expect(
      await peer.call('fields', 'sync.offer', {
        filePath: 'x',
        secret: 'x',
        extra: true,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    })
  })

  it('does not apply a duplicate request id twice and stops active offers on stdin EOF', async () => {
    const peer = host()
    peer.send({ type: 'handshake', protocolVersion: 1 })
    const path = join(directory, 'opaque.enc')
    await writeFile(path, 'opaque ciphertext')
    const first = await peer.call('same', 'sync.offer', {
      filePath: path,
      secret: 'ab'.repeat(32),
    })
    expect(first['ok']).toBe(true)
    expect(
      await peer.call('same', 'sync.offer', { filePath: path, secret: 'ab'.repeat(32) }),
    ).toMatchObject({
      ok: false,
      error: { code: 'PROTOCOL_ERROR' },
    })
    peer.input.end()
    await peer.instance.server.stop()
    const result = first['result'] as { offerId: string }
    expect(peer.instance.transport.status({ id: result.offerId }).state).toBe('cancelled')
  })

  it('bounds and drains oversized input without echoing a pairing secret into errors or diagnostics', async () => {
    const peer = host()
    const secret = 'cf'.repeat(32)
    peer.input.write(`${secret}${'x'.repeat(1024 * 1024)}\n`)
    await peer.take((message) => message['ok'] === false)
    peer.send({ type: 'handshake', protocolVersion: 1 })
    expect(await peer.take((message) => message['type'] === 'ready')).toHaveProperty(
      'pluginId',
      'studio.window-sync',
    )
    const response = await peer.call('secret', 'sync.offer', {
      filePath: join(directory, secret),
      secret,
    })
    expect(JSON.stringify(response)).not.toContain(secret)
    expect(peer.logs()).not.toContain(secret)
    expect(await readdir(directory)).toEqual([])
  })

  it('cancels an in-flight offer hash without leaving an unreported listener', async () => {
    const peer = host()
    peer.send({ type: 'handshake', protocolVersion: 1 })
    const filePath = join(directory, 'pending.enc')
    await writeFile(filePath, Buffer.alloc(4 * 1024 * 1024))
    const response = peer.call('cancel-call', 'sync.offer', {
      filePath,
      secret: 'ab'.repeat(32),
    })
    peer.send({ type: 'cancel', requestId: 'cancel-call' })
    expect(await response).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
    await peer.instance.server.stop()
    expect(
      peer.messages.filter((message) => message['requestId'] === 'cancel-call'),
    ).toEqual([])
  })
})
