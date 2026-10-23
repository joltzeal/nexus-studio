import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import type { EndpointRecord, GroupRecord } from '../domain/schemas.js'

type PortableEndpoint = Omit<
  EndpointRecord,
  'secretRef' | 'credentialFingerprint' | 'fingerprint' | 'deleted' | 'deletedAt'
> & { password: string | null }

interface TransferData {
  schemaVersion: 1
  defaultEndpointId: number | null
  endpoints: PortableEndpoint[]
  groups: GroupRecord[]
}

interface ImportResult {
  receipt: string
  endpointIdMap: Record<string, number>
}

interface Reply {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

const children: ChildProcessWithoutNullStreams[] = []
const directories: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  }
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'proxy-transfer-rpc-'))
  directories.push(value)
  return value
}

async function rpc(storageDirectory = '') {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../dist/src/index.js', import.meta.url))],
    { env: { ...process.env, NEXUS_PLUGIN_STORAGE_DIR: storageDirectory } },
  )
  children.push(child)
  let diagnostics = ''
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString()
  })
  const lines = createInterface({ input: child.stdout })
  const pending = new Map<string, (reply: Reply) => void>()
  let ready: (message: { methods: string[] }) => void = () => undefined
  const handshaken = new Promise<{ methods: string[] }>((resolve) => {
    ready = resolve
  })
  lines.on('line', (line) => {
    const message = JSON.parse(line) as Reply & {
      type?: string
      requestId?: string
      methods: string[]
    }
    if (message.type === 'ready') ready(message)
    if (message.requestId !== undefined) pending.get(message.requestId)?.(message)
  })
  child.stdin.write('{"type":"handshake","protocolVersion":1}\n')
  const handshake = await handshaken
  let sequence = 0
  const request = (method: string, payload: unknown = {}): Promise<Reply> => {
    const requestId = `rpc-${String(++sequence)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RPC response timed out')), 4000)
      pending.set(requestId, (reply) => {
        clearTimeout(timer)
        pending.delete(requestId)
        resolve(reply)
      })
      child.stdin.write(
        `${JSON.stringify({
          protocolVersion: 1,
          requestId,
          capability: 'proxy.provider',
          method,
          payload,
          deadlineMs: 3000,
        })}\n`,
      )
    })
  }
  return {
    child,
    handshake,
    request,
    logs: () => diagnostics,
    async call<T>(method: string, payload: unknown = {}): Promise<T> {
      const reply = await request(method, payload)
      expect(reply, `RPC ${method}`).toMatchObject({ ok: true })
      return reply.result as T
    },
  }
}

type Client = Awaited<ReturnType<typeof rpc>>

async function endpoint(client: Client, overrides: Record<string, unknown> = {}) {
  const created = await client.call<{ id: string }>('proxy.create', {
    name: 'portable endpoint',
    host: 'portable.example',
    port: 1080,
    schemes: ['socks5h', 'https'],
    username: 'user:@',
    password: ' p@ss:/ secret ',
    enabled: true,
    udp: false,
    ...overrides,
  })
  return Number(created.id)
}

const selection = (endpointIds: number[] = []) => ({
  windowIds: ['old-window'],
  endpointIds,
})

describe('portable proxy transfer over the real Node RPC process', () => {
  it('exports requested endpoints and the default with credentials and only related groups', async () => {
    const client = await rpc(await directory())
    const group = await client.call<GroupRecord>('proxy.groups.create', { name: 'EU' })
    await client.call('proxy.groups.create', { name: 'unrelated group' })
    const selected = await endpoint(client, { groupId: group.id, enabled: false })
    const defaultId = await endpoint(client, {
      host: 'default.example',
      password: 'default-password',
    })
    await endpoint(client, { host: 'unrelated.example', password: 'unrelated-password' })
    await client.call('proxy.config.set', {
      defaultEndpointId: defaultId,
      riskApiKey: 'global-api-secret',
    })
    await client.call('proxy.subscriptions.create', {
      name: 'private subscription',
      proxyIds: [selected],
    })

    const data = await client.call<TransferData>('transfer.export', selection([selected]))
    expect(client.handshake.methods).toEqual(
      expect.arrayContaining([
        'transfer.export',
        'transfer.import',
        'transfer.rollback',
        'transfer.commit',
      ]),
    )
    expect(data.defaultEndpointId).toBe(defaultId)
    expect(data.schemaVersion).toBe(1)
    expect(data.endpoints.map((entry) => entry.id).sort()).toEqual(
      [selected, defaultId].sort(),
    )
    expect(data.endpoints.find((entry) => entry.id === selected)).toMatchObject({
      username: 'user:@',
      password: ' p@ss:/ secret ',
      schemes: ['https', 'socks5h'],
      groupId: group.id,
      enabled: false,
      udp: false,
    })
    expect(data.groups).toEqual([group])
    const serialized = JSON.stringify(data)
    for (const excluded of [
      'unrelated-password',
      'global-api-secret',
      'subscription',
      'secretRef',
      'fingerprint',
    ]) {
      expect(serialized).not.toContain(excluded)
    }
    expect(client.logs()).not.toContain(' p@ss:/ secret ')
  })

  it('uses the default for an empty selection, exports no inventory when neither is configured', async () => {
    const client = await rpc(await directory())
    const id = await endpoint(client)
    const explicit = await client.call<TransferData>('transfer.export', selection([id]))
    expect(explicit.defaultEndpointId).toBeNull()
    expect(explicit.endpoints.map((entry) => entry.id)).toEqual([id])
    expect(await client.call('transfer.export', selection())).toEqual({
      schemaVersion: 1,
      defaultEndpointId: null,
      endpoints: [],
      groups: [],
    })
    await client.call('proxy.config.set', { defaultEndpointId: id })
    expect(await client.call<TransferData>('transfer.export', selection())).toMatchObject(
      {
        defaultEndpointId: id,
        endpoints: [{ id, password: ' p@ss:/ secret ' }],
      },
    )
    const otherId = await endpoint(client, { host: 'explicit.example' })
    expect(
      await client.call<TransferData>('transfer.export', {
        ...selection([otherId]),
        includeDefault: false,
      }),
    ).toMatchObject({
      defaultEndpointId: id,
      endpoints: [{ id: otherId }],
    })
  })

  it('fails the entire export for a missing or deleted explicitly selected endpoint', async () => {
    const client = await rpc(await directory())
    const id = await endpoint(client)
    expect(
      await client.request('transfer.export', selection([id, 987654])),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    })
    await client.call('proxy.delete', { ids: [id] })
    expect(await client.request('transfer.export', selection([id]))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    })
  })

  it('creates independent copies, rolls back after restart, and preserves existing endpoints, secrets and groups', async () => {
    const source = await rpc(await directory())
    const group = await source.call<GroupRecord>('proxy.groups.create', { name: 'EU' })
    const sourceId = await endpoint(source, { groupId: group.id })
    await source.call('proxy.config.set', { defaultEndpointId: sourceId })
    const data = await source.call<TransferData>('transfer.export', selection([sourceId]))

    const targetDirectory = await directory()
    const target = await rpc(targetDirectory)
    const existingGroup = await target.call<GroupRecord>('proxy.groups.create', {
      name: 'EU',
    })
    const existingId = await endpoint(target, { groupId: existingGroup.id })
    await target.call('proxy.config.set', {
      defaultEndpointId: existingId,
      riskApiKey: 'keep-api-key',
    })
    const beforeSecrets = JSON.parse(
      await readFile(join(targetDirectory, 'secrets.json'), 'utf8'),
    ) as unknown
    const imported = await target.call<ImportResult>('transfer.import', {
      data,
      windowIdMap: { 'old-window': 'new-window' },
    })
    const newId = imported.endpointIdMap[String(sourceId)]
    expect(newId).toBeTypeOf('number')
    expect(newId).not.toBe(existingId)
    expect(imported.receipt).toBeTypeOf('string')
    const copied = await target.call<TransferData>('transfer.export', selection([newId!]))
    expect(copied.endpoints.find((entry) => entry.id === newId)).toMatchObject({
      ...data.endpoints[0],
      id: newId,
      groupId: expect.any(Number),
    })
    expect(
      (await target.call<{ defaultEndpointId: string }>('proxy.config.get'))
        .defaultEndpointId,
    ).toBe(String(existingId))

    const exited = once(target.child, 'exit')
    target.child.kill()
    await exited
    const restarted = await rpc(targetDirectory)
    expect(
      await restarted.call('transfer.rollback', { receipt: imported.receipt }),
    ).toEqual({ success: true })
    expect(
      await restarted.call('transfer.rollback', { receipt: imported.receipt }),
    ).toEqual({ success: true })
    expect(await restarted.call('proxy.list')).toMatchObject({
      total: 1,
      items: [{ id: String(existingId) }],
    })
    expect(await restarted.call('proxy.groups.list')).toEqual({ items: [existingGroup] })
    expect(
      JSON.parse(await readFile(join(targetDirectory, 'secrets.json'), 'utf8')),
    ).toEqual(beforeSecrets)
  })

  it('commits durably, so a later rollback cannot delete the imported data', async () => {
    const client = await rpc(await directory())
    const id = await endpoint(client)
    const data = await client.call<TransferData>('transfer.export', selection([id]))
    const targetDirectory = await directory()
    const target = await rpc(targetDirectory)
    const imported = await target.call<ImportResult>('transfer.import', {
      data,
      windowIdMap: {},
    })
    expect(await target.call('transfer.commit', { receipt: imported.receipt })).toEqual({
      success: true,
    })
    expect(await target.call('transfer.commit', { receipt: imported.receipt })).toEqual({
      success: true,
    })
    const exited = once(target.child, 'exit')
    target.child.kill()
    await exited
    const restarted = await rpc(targetDirectory)
    await restarted.call('transfer.rollback', { receipt: imported.receipt })
    expect(await restarted.call('proxy.list')).toMatchObject({ total: 1 })
    expect(
      await restarted.call('proxy.resolve', {
        endpointId: imported.endpointIdMap[String(id)],
      }),
    ).toMatchObject({
      connectionUrl:
        'socks5h://user%3A%40:%20p%40ss%3A%2F%20secret%20@portable.example:1080',
    })
    expect(
      await readFile(join(targetDirectory, 'proxy-pool.json'), 'utf8'),
    ).not.toContain(imported.receipt)
  })

  it('uses a caller transaction UUID as a durable receipt and makes retries idempotent', async () => {
    const source = await rpc(await directory())
    const id = await endpoint(source)
    const data = await source.call<TransferData>('transfer.export', selection([id]))
    const targetDirectory = await directory()
    const target = await rpc(targetDirectory)
    const transactionId = 'b2c5fbd6-ff2b-46a8-b4a0-916b8120df58'
    const payload = { data, windowIdMap: {}, transactionId }
    const imported = await target.call<ImportResult>('transfer.import', payload)
    expect(imported.receipt).toBe(transactionId)
    expect(await target.call('transfer.import', payload)).toEqual(imported)
    expect(await target.call('proxy.list')).toMatchObject({ total: 1 })
    expect(
      await target.request('transfer.import', {
        ...payload,
        data: { ...data, endpoints: [{ ...data.endpoints[0], password: 'different' }] },
      }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    const exited = once(target.child, 'exit')
    target.child.kill()
    await exited
    const restarted = await rpc(targetDirectory)
    await restarted.call('transfer.rollback', { receipt: transactionId })
    expect(await restarted.call('proxy.list')).toMatchObject({ total: 0 })
  })

  it('leaves existing inventory and secrets intact on repeated real vault failures', async () => {
    const source = await rpc(await directory())
    const id = await endpoint(source)
    const data = await source.call<TransferData>('transfer.export', selection([id]))
    const targetDirectory = await directory()
    const target = await rpc(targetDirectory)
    await endpoint(target, { host: 'keep.example' })
    const before = await target.call('proxy.list')
    const beforeSecrets = JSON.parse(
      await readFile(join(targetDirectory, 'secrets.json'), 'utf8'),
    ) as unknown
    const obstruction = join(targetDirectory, 'secrets.json.tmp')
    await mkdir(obstruction)
    const payload = {
      data,
      windowIdMap: {},
      transactionId: '4e80ff51-46a1-4fee-8b55-bc8e65b557d3',
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await target.request('transfer.import', payload)).toMatchObject({
        ok: false,
        error: { code: 'UNAVAILABLE' },
      })
      expect(await target.call('proxy.list')).toEqual(before)
      expect(
        JSON.parse(await readFile(join(targetDirectory, 'secrets.json'), 'utf8')),
      ).toEqual(beforeSecrets)
    }
    await rm(obstruction, { recursive: true })
    const imported = await target.call<ImportResult>('transfer.import', payload)
    await target.call('transfer.rollback', { receipt: imported.receipt })
    expect(await target.call('proxy.list')).toEqual(before)
    expect(
      JSON.parse(await readFile(join(targetDirectory, 'secrets.json'), 'utf8')),
    ).toEqual(beforeSecrets)
  })

  it('rejects malformed transfer data and extra fields without creating rows or echoing secrets', async () => {
    const source = await rpc(await directory())
    const id = await endpoint(source)
    const data = await source.call<TransferData>('transfer.export', selection([id]))
    const target = await rpc(await directory())
    const malformed = [
      { ...data, schemaVersion: 2 },
      { ...data, apiKey: 'never-echo-this-secret' },
      { ...data, defaultEndpointId: -1 },
      { ...data, endpoints: [...data.endpoints, ...data.endpoints] },
      { ...data, endpoints: [{ ...data.endpoints[0], groupId: 9999 }] },
      { ...data, endpoints: [{ ...data.endpoints[0], port: 0 }] },
      { ...data, endpoints: [{ ...data.endpoints[0], secretRef: 'file:foreign' }] },
      {
        ...data,
        endpoints: data.endpoints.map((entry) =>
          Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'username')),
        ),
      },
    ]
    for (const invalid of malformed) {
      const response = await target.request('transfer.import', {
        data: invalid,
        windowIdMap: {},
      })
      expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
      expect(JSON.stringify(response)).not.toContain('never-echo-this-secret')
    }
    expect(
      await target.request('transfer.export', {
        ...selection(),
        password: 'never-echo-this-secret',
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    })
    expect(await target.call('proxy.list')).toMatchObject({ total: 0 })
    expect(await target.call('proxy.groups.list')).toEqual({ items: [] })
  })
})
