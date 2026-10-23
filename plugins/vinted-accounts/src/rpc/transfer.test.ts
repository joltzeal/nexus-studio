import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import type { AccountInput, AccountRecord, BindingRecord } from '../domain/types.js'

interface TransferData {
  schemaVersion: 1
  accounts: AccountRecord[]
  bindings: BindingRecord[]
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
  const value = await mkdtemp(join(tmpdir(), 'account-transfer-rpc-'))
  directories.push(value)
  return value
}

async function rpc(storageDirectory: string) {
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
          capability: 'account.pool',
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

async function account(client: Client, overrides: Partial<AccountInput> = {}) {
  const saved = await client.call<{ item: AccountRecord }>('vinted.accounts.save', {
    loginMethod: 'apple',
    account: 'portable@example.test',
    password: ' portable password ',
    phone: '+33 123456',
    emailOtpUrl: 'https://mail.example.test/inbox?token=private-mail',
    smsOtpUrl: 'https://sms.example.test/inbox?token=private-sms',
    note: 'preserve the note',
    status: 'limited',
    homepageUrl: 'https://vinted.fr/member/42',
    ...overrides,
  })
  return saved.item
}

async function bind(client: Client, accountId: string, windowId: string) {
  await client.call('vinted.accounts.bind', {
    accountId,
    windowId,
    confirmDuplicates: true,
  })
}

const selection = (windowIds: string[]) => ({ windowIds, endpointIds: [] })

describe('portable accounts transfer over the real Node RPC process', () => {
  it('exports credentials only for accounts bound to selected windows', async () => {
    const source = await rpc(await directory())
    const linked = await account(source)
    const unrelated = await account(source, {
      account: 'unrelated@example.test',
      password: 'unrelated-password',
    })
    await bind(source, linked.id, 'old-one')
    await bind(source, linked.id, 'old-two')
    await bind(source, unrelated.id, 'unselected')
    const data = await source.call<TransferData>(
      'transfer.export',
      selection(['old-one', 'old-one', 'unbound']),
    )
    expect(source.handshake.methods).toEqual(
      expect.arrayContaining([
        'transfer.export',
        'transfer.import',
        'transfer.rollback',
        'transfer.commit',
      ]),
    )
    expect(data).toEqual({
      schemaVersion: 1,
      accounts: [linked],
      bindings: [
        { windowId: 'old-one', accountId: linked.id, boundAt: expect.any(String) },
      ],
    })
    expect(JSON.stringify(data)).not.toContain('unrelated-password')
    expect(source.logs()).not.toContain(' portable password ')
    expect(await source.call('transfer.export', selection([]))).toEqual({
      schemaVersion: 1,
      accounts: [],
      bindings: [],
    })
  })

  it('remaps all selected bindings to a fresh copy, preserves every field and rolls back after restart', async () => {
    const source = await rpc(await directory())
    const original = await account(source)
    await bind(source, original.id, 'old-one')
    await bind(source, original.id, 'old-two')
    const data = await source.call<TransferData>(
      'transfer.export',
      selection(['old-one', 'old-two']),
    )
    const targetDirectory = await directory()
    const target = await rpc(targetDirectory)
    const existing = await account(target, { password: 'existing-password' })
    await bind(target, existing.id, 'existing-window')
    const before = await target.call('vinted.accounts.list')

    const imported = await target.call<{ receipt: string }>('transfer.import', {
      data,
      windowIdMap: { 'old-one': 'new-one', 'old-two': 'new-two' },
    })
    const list = await target.call<{ items: AccountRecord[]; bindings: BindingRecord[] }>(
      'vinted.accounts.list',
    )
    const copied = list.items.find((entry) => entry.id !== existing.id)
    expect(copied).toEqual({ ...original, id: expect.any(String) })
    expect(copied?.id).not.toBe(original.id)
    expect(list.bindings.filter((entry) => entry.accountId === copied?.id)).toEqual([
      { ...data.bindings[0], windowId: 'new-one', accountId: copied?.id },
      { ...data.bindings[1], windowId: 'new-two', accountId: copied?.id },
    ])
    const exited = once(target.child, 'exit')
    target.child.kill()
    await exited
    const restarted = await rpc(targetDirectory)
    expect(await restarted.call('transfer.rollback', imported)).toEqual({ success: true })
    expect(await restarted.call('transfer.rollback', imported)).toEqual({ success: true })
    expect(await restarted.call('vinted.accounts.list')).toEqual(before)
  })

  it('rejects missing mappings, duplicate target windows, existing bindings and malformed data atomically', async () => {
    const source = await rpc(await directory())
    const original = await account(source)
    await bind(source, original.id, 'old-one')
    await bind(source, original.id, 'old-two')
    const data = await source.call<TransferData>(
      'transfer.export',
      selection(['old-one', 'old-two']),
    )
    const target = await rpc(await directory())
    const existing = await account(target)
    await bind(target, existing.id, 'occupied')
    const before = await target.call('vinted.accounts.list')
    const badInputs = [
      { data, windowIdMap: {} },
      { data, windowIdMap: { 'old-one': 'one' } },
      { data, windowIdMap: { 'old-one': 'same', 'old-two': 'same' } },
      { data, windowIdMap: { 'old-one': 'occupied', 'old-two': 'new' } },
      { data: { ...data, schemaVersion: 2 }, windowIdMap: {} },
      {
        data: { ...data, accounts: [...data.accounts, ...data.accounts] },
        windowIdMap: {},
      },
      {
        data: { ...data, bindings: [{ ...data.bindings[0], accountId: 'missing' }] },
        windowIdMap: {},
      },
      { data: { ...data, bindings: [] }, windowIdMap: {} },
      { data: { ...data, token: 'never-echo-this-secret' }, windowIdMap: {} },
    ]
    for (const input of badInputs) {
      const response = await target.request('transfer.import', input)
      expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
      expect(JSON.stringify(response)).not.toContain('never-echo-this-secret')
      expect(await target.call('vinted.accounts.list')).toEqual(before)
    }
  })

  it('leaves no partial imports after repeated real storage failures and can retry', async () => {
    const source = await rpc(await directory())
    const original = await account(source)
    await bind(source, original.id, 'old-one')
    const data = await source.call<TransferData>(
      'transfer.export',
      selection(['old-one']),
    )
    const targetDirectory = await directory()
    const target = await rpc(targetDirectory)
    const existing = await account(target, { account: 'keep@example.test' })
    const before = await target.call('vinted.accounts.list')
    const obstruction = join(targetDirectory, 'vinted-accounts.json.tmp')
    await mkdir(obstruction)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        await target.request('transfer.import', {
          data,
          windowIdMap: { 'old-one': 'new-one' },
        }),
      ).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
      expect(await target.call('vinted.accounts.list')).toEqual(before)
    }
    await rm(obstruction, { recursive: true })
    const imported = await target.call<{ receipt: string }>('transfer.import', {
      data,
      windowIdMap: { 'old-one': 'new-one' },
    })
    await mkdir(obstruction)
    expect(await target.request('transfer.commit', imported)).toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE' },
    })
    await rm(obstruction, { recursive: true })
    await target.call('transfer.rollback', imported)
    expect(await target.call('vinted.accounts.list')).toMatchObject({
      items: [existing],
      bindings: [],
    })
  })

  it('commit cleans its receipt durably without deleting credentials or remapped bindings', async () => {
    const source = await rpc(await directory())
    const original = await account(source)
    await bind(source, original.id, 'old-one')
    const data = await source.call<TransferData>(
      'transfer.export',
      selection(['old-one']),
    )
    const targetDirectory = await directory()
    const target = await rpc(targetDirectory)
    const imported = await target.call<{ receipt: string }>('transfer.import', {
      data,
      windowIdMap: { 'old-one': 'new-one' },
    })
    expect(await target.call('transfer.commit', imported)).toEqual({ success: true })
    expect(await target.call('transfer.commit', imported)).toEqual({ success: true })
    const exited = once(target.child, 'exit')
    target.child.kill()
    await exited
    const restarted = await rpc(targetDirectory)
    await restarted.call('transfer.rollback', imported)
    expect(await restarted.call('vinted.accounts.list')).toMatchObject({
      total: 1,
      items: [{ ...original, id: expect.any(String) }],
      bindings: [{ windowId: 'new-one' }],
    })
    expect(
      await readFile(join(targetDirectory, 'vinted-accounts.json'), 'utf8'),
    ).not.toContain(imported.receipt)
  })

  it('rollback preserves a target window that has since been rebound to an existing account', async () => {
    const client = await rpc(await directory())
    const original = await account(client)
    await bind(client, original.id, 'old-one')
    const data = await client.call<TransferData>(
      'transfer.export',
      selection(['old-one']),
    )
    const imported = await client.call<{ receipt: string }>('transfer.import', {
      data,
      windowIdMap: { 'old-one': 'new-one' },
    })
    await bind(client, original.id, 'new-one')
    await client.call('transfer.rollback', imported)
    expect(await client.call('vinted.accounts.list')).toMatchObject({
      total: 1,
      bindings: [
        { windowId: 'old-one', accountId: original.id },
        { windowId: 'new-one', accountId: original.id },
      ],
    })
  })

  it('restores the prior binding for a same-id window replacement using a durable caller receipt', async () => {
    const source = await rpc(await directory())
    const original = await account(source)
    await bind(source, original.id, 'same-window')
    const data = await source.call<TransferData>(
      'transfer.export',
      selection(['same-window']),
    )
    const targetDirectory = await directory()
    const target = await rpc(targetDirectory)
    const existing = await account(target, { account: 'existing@example.test' })
    await bind(target, existing.id, 'same-window')
    await bind(target, existing.id, 'unrelated-window')
    const before = await target.call('vinted.accounts.list')
    const transactionId = 'b2c5fbd6-ff2b-46a8-b4a0-916b8120df58'
    const payload = {
      data,
      windowIdMap: { 'same-window': 'same-window' },
      transactionId,
    }
    expect(await target.call('transfer.import', payload)).toEqual({
      receipt: transactionId,
    })
    expect(await target.call('transfer.import', payload)).toEqual({
      receipt: transactionId,
    })
    expect(await target.call('vinted.accounts.list')).toMatchObject({
      total: 2,
      bindings: expect.arrayContaining([
        expect.objectContaining({
          windowId: 'same-window',
          accountId: expect.not.stringMatching(existing.id),
        }),
        expect.objectContaining({ windowId: 'unrelated-window', accountId: existing.id }),
      ]),
    })
    const exited = once(target.child, 'exit')
    target.child.kill()
    await exited
    const restarted = await rpc(targetDirectory)
    expect(await restarted.call('transfer.rollback', { receipt: transactionId })).toEqual(
      { success: true },
    )
    expect(await restarted.call('vinted.accounts.list')).toEqual(before)
  })
})
