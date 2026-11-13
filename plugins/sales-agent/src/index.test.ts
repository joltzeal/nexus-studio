import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createSalesAgentPlugin } from './index.js'
import type { SettingsStore } from './store/settings.js'

function handshake(options: Parameters<typeof createSalesAgentPlugin>[0]) {
  const input = new PassThrough()
  const output = new PassThrough()
  const records: Record<string, unknown>[] = []
  output.on('data', (chunk: Buffer) => records.push(JSON.parse(chunk.toString())))
  const instance = createSalesAgentPlugin({ ...options, input, output })
  try {
    instance.server.start()
    input.write('{"type":"handshake","protocolVersion":1}\n')
    return records.find((record) => record.type === 'ready')
  } finally {
    instance.stop()
    input.destroy()
    output.destroy()
  }
}

describe('Ecom Agent storage handshake', () => {
  it('advertises durable storage when using the managed settings directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-agent-handshake-'))
    try {
      expect(handshake({ storageDirectory: directory })).toMatchObject({
        pluginId: 'studio.sales-agent',
        status: { storageDurable: true },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not claim durability for an injected store even with a directory option', () => {
    const store: SettingsStore = {
      read: async () => null,
      save: async () => {
        throw new Error('Not used by handshake')
      },
      clear: async () => {},
    }
    expect(handshake({ store, storageDirectory: '/unused' })).toMatchObject({
      status: { storageDurable: false },
    })
  })
})
