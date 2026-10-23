import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { unavailable } from '../domain/errors.js'
import { createProxyPlugin } from '../index.js'
import type { DispatchContext } from '../rpc/protocol.js'

const directories: string[] = []
const diagnostics = new Writable({ write: (_chunk, _encoding, done) => done() })

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'proxy-transfer-failures-'))
  directories.push(directory)
  return { directory, ...createProxyPlugin({ storageDirectory: directory, diagnostics }) }
}

function context(method: string, payload: unknown): DispatchContext {
  return {
    requestId: method,
    capability: 'proxy.provider',
    method,
    payload,
    deadlineAt: Date.now() + 30_000,
    assertAlive: () => undefined,
  }
}

async function sourceData() {
  const source = await fixture()
  for (const host of ['one.example', 'two.example']) {
    await source.plugin.call(
      context('proxy.create', {
        name: host,
        host,
        port: 1080,
        schemes: ['socks5'],
        password: `password-${host}`,
      }),
    )
  }
  return source.plugin.call(
    context('transfer.export', { windowIds: [], endpointIds: [1, 2] }),
  )
}

async function secrets(directory: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(directory, 'secrets.json'), 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

describe('proxy transfer compensation', () => {
  it('cleans the first created secret when a later secret fails, including repeated retries', async () => {
    const data = await sourceData()
    const target = await fixture()
    const put = target.vault.put.bind(target.vault)
    let calls = 0
    vi.spyOn(target.vault, 'put').mockImplementation(async (...args) => {
      calls += 1
      if (calls % 2 === 0) throw unavailable('injected vault failure')
      return put(...args)
    })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        target.plugin.call(context('transfer.import', { data, windowIdMap: {} })),
      ).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      })
      expect((await target.store.read()).endpoints).toEqual([])
      expect((await target.store.read()).groups).toEqual([])
      expect(await secrets(target.directory)).toEqual({})
    }
  })

  it('keeps a recovery receipt if inventory writes fail after secret staging, and recovers after restart', async () => {
    const data = await sourceData()
    const target = await fixture()
    const put = target.vault.put.bind(target.vault)
    const obstruction = join(target.directory, 'proxy-pool.json.tmp')
    let blocked = false
    vi.spyOn(target.vault, 'put').mockImplementation(async (...args) => {
      const stored = await put(...args)
      if (!blocked) {
        blocked = true
        await mkdir(obstruction)
      }
      return stored
    })
    await expect(
      target.plugin.call(context('transfer.import', { data, windowIdMap: {} })),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    expect((await target.store.read()).endpoints).toEqual([])
    await expect(
      target.plugin.call(context('transfer.import', { data, windowIdMap: {} })),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    await rm(obstruction, { recursive: true })
    const restarted = createProxyPlugin({
      storageDirectory: target.directory,
      diagnostics,
    })
    expect(
      await restarted.plugin.call(
        context('transfer.export', { windowIds: [], endpointIds: [] }),
      ),
    ).toMatchObject({
      endpoints: [],
      groups: [],
    })
    expect(await secrets(target.directory)).toEqual({})
    const imported = (await restarted.plugin.call(
      context('transfer.import', { data, windowIdMap: {} }),
    )) as { receipt: string }
    await restarted.plugin.call(
      context('transfer.rollback', { receipt: imported.receipt }),
    )
    expect((await restarted.store.read()).endpoints).toEqual([])
    expect(await secrets(target.directory)).toEqual({})
  })

  it('retries a failed rollback without touching an unrelated secret', async () => {
    const data = await sourceData()
    const target = await fixture()
    const existing = await target.vault.put('proxycheck-api-key', 'keep-this-api-key')
    const imported = (await target.plugin.call(
      context('transfer.import', { data, windowIdMap: {} }),
    )) as { receipt: string }
    const obstruction = join(target.directory, 'secrets.json.tmp')
    await mkdir(obstruction)
    await expect(
      target.plugin.call(context('transfer.rollback', { receipt: imported.receipt })),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await rm(obstruction, { recursive: true })
    const restarted = createProxyPlugin({
      storageDirectory: target.directory,
      diagnostics,
    })
    await restarted.plugin.call(
      context('transfer.rollback', { receipt: imported.receipt }),
    )
    expect((await restarted.store.read()).endpoints).toEqual([])
    expect(await secrets(target.directory)).toEqual({
      [existing.ref]: 'keep-this-api-key',
    })
  })

  it('fails export when a selected password reference cannot be resolved', async () => {
    const source = await fixture()
    await source.plugin.call(
      context('proxy.create', {
        name: 'requires auth',
        schemes: ['http'],
        host: 'auth.example',
        port: 8080,
        password: 'required-password',
      }),
    )
    const ref = (await source.store.read()).endpoints[0]?.secretRef
    if (ref === null || ref === undefined) throw new Error('missing test secret')
    await source.vault.drop(ref)
    await expect(
      source.plugin.call(context('transfer.export', { windowIds: [], endpointIds: [1] })),
    ).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    })
  })

  it('cancels before staging without leaving rows or credentials', async () => {
    const data = await sourceData()
    const target = await fixture()
    const request = context('transfer.import', { data, windowIdMap: {} })
    request.assertAlive = () => {
      throw unavailable('cancelled test request')
    }
    await expect(target.plugin.call(request)).rejects.toThrow()
    expect((await target.store.read()).endpoints).toEqual([])
    expect(await secrets(target.directory)).toEqual({})
  })

  it('preserves observation history, status, timestamps and group metadata as local snapshot values', async () => {
    const source = await fixture()
    await source.plugin.call(context('proxy.groups.create', { name: 'archived group' }))
    await source.plugin.call(
      context('proxy.create', {
        name: 'snapshot',
        schemes: ['http'],
        host: 'snapshot.example',
        port: 8080,
        password: 'snapshot-password',
        groupId: 1,
        enabled: false,
        udp: false,
      }),
    )
    await source.store.mutate((document) => {
      const row = document.endpoints[0]!
      Object.assign(row, {
        checkStatus: 'failed',
        checkedScheme: 'http',
        checkedAt: '2026-10-01T00:00:00Z',
        exitIp: '203.0.113.20',
        exitIpCheckedAt: '2026-10-01T00:00:00Z',
        previousExitIp: '203.0.113.19',
        previousExitIpCheckedAt: '2026-09-01T00:00:00Z',
        geo: {
          status: 'ok',
          source: 'proxycheck.io',
          country: 'France',
          countryCode: 'FR',
          region: 'Ile-de-France',
          city: 'Paris',
          isp: 'test isp',
          error: null,
        },
        riskScore: 12,
        isProxy: true,
        isVpn: false,
        isHosting: true,
        latencyMs: 234,
        checkError: 'historical failure',
        createdAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      })
    })
    const payload = { windowIds: [], endpointIds: [2] }
    const data = (await source.plugin.call(context('transfer.export', payload))) as {
      endpoints: Array<Record<string, unknown>>
      groups: Array<Record<string, unknown>>
    }
    const target = await fixture()
    const imported = (await target.plugin.call(
      context('transfer.import', { data, windowIdMap: {} }),
    )) as {
      receipt: string
      endpointIdMap: Record<string, number>
    }
    const copied = (await target.plugin.call(
      context('transfer.export', {
        windowIds: [],
        endpointIds: [imported.endpointIdMap['2']],
      }),
    )) as typeof data
    expect(copied.endpoints[0]).toEqual({
      ...data.endpoints[0],
      id: imported.endpointIdMap['2'],
      groupId: copied.groups[0]?.['id'],
    })
    expect(copied.groups[0]).toEqual({ ...data.groups[0], id: copied.groups[0]?.['id'] })
  })
})
