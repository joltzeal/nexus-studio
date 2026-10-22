import { chmod, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { isPluginFailure } from '../domain/errors.js'
import type { ProxyInput } from '../domain/schemas.js'
import { createFileStore, createMemoryStore } from '../store/private-store.js'
import { Redactor } from '../rpc/redact.js'
import { createMemoryVault } from '../store/secret-vault.js'
import {
  createEndpoint,
  deleteEndpoints,
  importEndpoints,
  resetObservation,
  toPublic,
  updateEndpoint,
} from './inventory.js'

const now = () => '2026-01-01T00:00:00.000Z'

function setup() {
  const redactor = new Redactor()
  return {
    store: createMemoryStore(),
    vault: createMemoryVault(redactor),
    redactor,
    now,
  }
}

function input(overrides: Partial<ProxyInput> = {}): ProxyInput {
  return {
    name: 'pool-1',
    schemes: ['http'],
    host: 'proxy.example',
    port: 8080,
    username: 'user',
    password: 'p@ssw0rd',
    enabled: true,
    udp: true,
    groupId: null,
    ...overrides,
  }
}

describe('proxy inventory', () => {
  it('keeps a vault reference instead of the password', async () => {
    const { store, vault } = setup()
    const row = await store.mutate((document) =>
      createEndpoint(document, input(), { vault, now }),
    )
    expect(row.secretRef).not.toBeNull()
    expect(row.secretRef).not.toContain('p@ssw0rd')
    expect(row.credentialFingerprint).not.toContain('p@ssw0rd')
    expect(toPublic(row).hasPassword).toBe(true)

    const stored = JSON.stringify(await store.read())
    expect(stored).not.toContain('p@ssw0rd')
  })

  it('rejects a duplicate address with the same credential', async () => {
    const { store, vault } = setup()
    await store.mutate((document) => createEndpoint(document, input(), { vault, now }))
    await expect(
      store.mutate((document) =>
        createEndpoint(document, input({ name: 'another' }), { vault, now }),
      ),
    ).rejects.toThrow('已存在相同地址及认证信息的代理，请编辑其协议列表')
  })

  it('treats a different password as a different endpoint', async () => {
    const { store, vault } = setup()
    const first = await store.mutate((document) =>
      createEndpoint(document, input(), { vault, now }),
    )
    const second = await store.mutate((document) =>
      createEndpoint(document, input({ name: 'pool-2', password: 'other' }), {
        vault,
        now,
      }),
    )
    expect(second.id).not.toBe(first.id)
    expect(second.fingerprint).not.toBe(first.fingerprint)
  })

  it('merges protocols when a duplicate arrives through import', async () => {
    const { store, vault } = setup()
    await store.mutate((document) => createEndpoint(document, input(), { vault, now }))
    const result = await store.mutate((document) =>
      importEndpoints(
        document,
        [input({ schemes: ['http', 'socks5'] }), input({ host: 'other.example' })],
        { vault, now },
      ),
    )
    expect(result).toEqual({ requested: 2, created: 1, duplicates: 0, merged: 1 })
    const document = await store.read()
    expect(document.endpoints[0]?.schemes).toEqual(['http', 'socks5'])
  })

  it('counts an identical import row as a duplicate without touching it', async () => {
    const { store, vault } = setup()
    await store.mutate((document) => createEndpoint(document, input(), { vault, now }))
    const result = await store.mutate((document) =>
      importEndpoints(document, [input()], { vault, now }),
    )
    expect(result).toEqual({ requested: 1, created: 0, duplicates: 1, merged: 0 })
  })

  it('clears observations when the address changes', async () => {
    const { store, vault } = setup()
    const created = await store.mutate((document) =>
      createEndpoint(document, input(), { vault, now }),
    )
    await store.mutate((document) => {
      const row = document.endpoints[0]
      if (row === undefined) throw new Error('missing row')
      row.checkStatus = 'ok'
      row.exitIp = '203.0.113.9'
      row.riskScore = 20
      return row
    })
    const updated = await store.mutate((document) =>
      updateEndpoint(document, input({ host: 'moved.example' }), {
        vault,
        now,
        existing: document.endpoints[0] ?? created,
      }),
    )
    expect(updated.checkStatus).toBe('unknown')
    expect(updated.exitIp).toBeNull()
    expect(updated.riskScore).toBeNull()
  })

  it('keeps observations when only the name changes', async () => {
    const { store, vault } = setup()
    await store.mutate((document) => createEndpoint(document, input(), { vault, now }))
    const updated = await store.mutate((document) => {
      const row = document.endpoints[0]
      if (row === undefined) throw new Error('missing row')
      row.checkStatus = 'ok'
      return updateEndpoint(document, input({ name: 'renamed' }), {
        vault,
        now,
        existing: row,
      })
    })
    expect(updated.checkStatus).toBe('ok')
  })

  it('soft deletes, hides the row and drops the secret', async () => {
    const { store, vault } = setup()
    const row = await store.mutate((document) =>
      createEndpoint(document, input(), { vault, now }),
    )
    const ref = row.secretRef
    await store.mutate((document) => deleteEndpoints(document, [row.id], { vault, now }))
    const document = await store.read()
    expect(document.endpoints[0]?.deleted).toBe(true)
    expect(document.endpoints[0]?.secretRef).toBeNull()
    expect(ref).not.toBeNull()
    await expect(vault.resolve(ref ?? '')).rejects.toThrow()
  })

  it('resetObservation clears a stale exit IP history', () => {
    const row = {
      checkStatus: 'ok',
      checkedScheme: 'http',
      checkedAt: '2026-01-01T00:00:00.000Z',
      exitIp: '203.0.113.9',
      exitIpCheckedAt: '2026-01-01T00:00:00.000Z',
      previousExitIp: '203.0.113.8',
      previousExitIpCheckedAt: '2025-12-31T00:00:00.000Z',
      geo: null,
      reputation: null,
      riskScore: 10,
      isProxy: true,
      isVpn: false,
      isHosting: false,
      latencyMs: 120,
      checkError: null,
    } as unknown as Parameters<typeof resetObservation>[0]
    resetObservation(row)
    expect(row.checkStatus).toBe('unknown')
    expect(row.previousExitIp).toBeNull()
  })
})

describe('private storage failures', () => {
  it('refuses to report a save that could not be written', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'proxy-pool-'))
    const store = createFileStore(directory)
    const redactor = new Redactor()
    const vault = createMemoryVault(redactor)
    await store.read()
    // A read-only directory makes the atomic rename fail.
    await chmod(directory, 0o500)

    const error = await store
      .mutate((document) => createEndpoint(document, input(), { vault, now }))
      .catch((reason: unknown) => reason)
    await chmod(directory, 0o700)

    expect(isPluginFailure(error)).toBe(true)
    if (isPluginFailure(error)) {
      expect(error.code).toBe('UNAVAILABLE')
      expect(error.message).toContain('未保存')
    }
    // The in-memory document must not keep the discarded mutation.
    expect((await store.read()).endpoints).toHaveLength(0)
  })
})
