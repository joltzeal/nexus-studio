import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { createEmailPlugin } from '../index.js'
import type { EmailProvider } from '../domain/types.js'

const provider: EmailProvider = {
  tokens: {
    async refresh() {
      return {
        accessToken: 'synthetic-access-persisted',
        refreshToken: 'synthetic-refresh-persisted',
        expiresIn: 3600,
      }
    },
  },
  mailbox: {
    async list() {
      return { items: [], nextCursor: null, total: 0, unread: 0 }
    },
    async setRead() {},
    async get() {
      throw new Error('not used')
    },
  },
}
function harness(storageDirectory?: string) {
  const input = new PassThrough()
  const output = new PassThrough()
  const diagnostics = new PassThrough()
  const messages: Record<string, unknown>[] = []
  const logs: string[] = []
  output.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split('\n'))
      messages.push(JSON.parse(line) as Record<string, unknown>)
  })
  diagnostics.on('data', (chunk: Buffer) => logs.push(chunk.toString()))
  const instance = createEmailPlugin({
    ...(storageDirectory ? { storageDirectory } : {}),
    input,
    output,
    diagnostics,
    providers: { get: () => provider },
  })
  instance.server.start()
  input.write('{"type":"handshake","protocolVersion":1}\n')
  return {
    ...instance,
    input,
    messages,
    logs,
    request(requestId: string, method: string, payload: unknown) {
      input.write(
        `${JSON.stringify({
          protocolVersion: 1,
          requestId,
          capability: 'email.provider',
          method,
          payload,
          deadlineMs: 5000,
        })}\n`,
      )
    },
    async close() {
      await instance.stop()
      input.destroy()
      output.destroy()
      diagnostics.destroy()
    },
  }
}

describe('email plugin lifecycle', () => {
  it('handshakes, persists a rotated pair, and reads it through a fresh process instance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-email-lifecycle-'))
    let t = harness(directory)
    try {
      expect(t.messages[1]).toMatchObject({
        type: 'ready',
        capabilities: ['email.provider'],
      })
      t.request('import', 'email.accounts.import', {
        transport: 'graph',
        text: 'owner@outlook.com----synthetic-password----00000000-0000-4000-8000-000000000001----synthetic-refresh-original',
      })
      await vi.waitFor(() =>
        expect(t.messages.find((x) => x.requestId === 'import')).toHaveProperty(
          'ok',
          true,
        ),
      )
      await t.plugin.tick()
      const text = await readFile(join(directory, 'email.json'), 'utf8')
      expect(text).toContain('synthetic-refresh-persisted')
      expect(text).toContain('synthetic-access-persisted')
      if (process.platform !== 'win32')
        expect((await stat(join(directory, 'email.json'))).mode & 0o777).toBe(0o600)
      await t.close()
      t = harness(directory)
      const account = (await t.store.read()).accounts[0]!
      expect(account.refreshToken).toBe('synthetic-refresh-persisted')
      t.request('list', 'email.accounts.list', {})
      await vi.waitFor(() =>
        expect(t.messages.find((x) => x.requestId === 'list')).toHaveProperty('ok', true),
      )
      expect(JSON.stringify(t.messages)).not.toContain('synthetic-')
      expect(t.logs.join('')).not.toContain('synthetic-')
    } finally {
      await t.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('cancels a queued configuration write when the host closes stdin', async () => {
    const t = harness()
    let release = () => {}
    const blocked = t.store.mutate(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      t.request('settings', 'configuration.import', {
        schemaVersion: 1,
        data: {
          autoRefresh: false,
          intervalMinutes: 15,
          autoReceive: false,
          receiveIntervalMinutes: 10,
        },
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      t.input.end()
      await new Promise<void>((resolve) => setImmediate(resolve))
      release()
      await blocked
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect((await t.store.read()).settings).toEqual({
        autoRefresh: true,
        intervalMinutes: 60,
        autoReceive: true,
        receiveIntervalMinutes: 1,
      })
    } finally {
      release()
      await t.close()
    }
  })
})
