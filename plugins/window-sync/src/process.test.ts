import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const packageRoot = join(root, 'plugins/window-sync')
const children: ChildProcessWithoutNullStreams[] = []
const sockets: Socket[] = []
const servers: Server[] = []
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nexus-sync-process-'))
})

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  await rm(directory, { recursive: true, force: true })
})

async function holdReceipt(invitation: string) {
  const original = JSON.parse(
    Buffer.from(invitation.slice(11), 'base64url').toString(),
  ) as { host: string; port: number }
  let receiptHeld!: () => void
  const held = new Promise<void>((resolve) => {
    receiptHeld = resolve
  })
  let receivedReceipt = false
  let forward: (() => void) | undefined
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = connect({ host: '127.0.0.1', port: original.port })
    sockets.push(client, upstream)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
    upstream.pipe(client)
    const input = createInterface({ input: client })
    input.on('line', (line) => {
      const message = JSON.parse(line) as { type: string }
      if (message.type === 'received') {
        receivedReceipt = true
        forward = () => upstream.write(`${line}\n`)
        receiptHeld()
      } else upstream.write(`${line}\n`)
    })
    client.on('end', () => {
      if (!receivedReceipt) upstream.end()
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    invitation: `nexus-sync:${Buffer.from(
      JSON.stringify({
        ...original,
        host: '127.0.0.1',
        port: (server.address() as { port: number }).port,
      }),
    ).toString('base64url')}`,
    held,
    release: () => {
      forward?.()
      forward = undefined
    },
  }
}

async function start(entry = join(packageRoot, 'dist/src/index.js')) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, NEXUS_PLUGIN_STORAGE_DIR: directory },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  const messages: Record<string, unknown>[] = []
  const updates = new EventEmitter()
  let pending = ''
  let errors = ''
  child.stdout.on('data', (chunk: Buffer) => {
    pending += chunk.toString()
    let newline: number
    while ((newline = pending.indexOf('\n')) !== -1) {
      messages.push(JSON.parse(pending.slice(0, newline)) as Record<string, unknown>)
      pending = pending.slice(newline + 1)
    }
    updates.emit('message')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString()
  })
  child.on('exit', () => updates.emit('message'))
  child.on('error', () => {
    errors += 'Could not start the built plugin; build packages before testing'
    updates.emit('message')
  })
  const take = async (predicate: (message: Record<string, unknown>) => boolean) => {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const finish = (error?: Error, message?: Record<string, unknown>): void => {
        clearTimeout(timer)
        updates.off('message', check)
        if (error) reject(error)
        else resolve(message!)
      }
      const check = (): void => {
        const index = messages.findIndex(predicate)
        if (index !== -1) finish(undefined, messages.splice(index, 1)[0]!)
        else if (child.exitCode !== null || child.signalCode !== null)
          finish(new Error(`Plugin exited: ${errors}`))
      }
      const timer = setTimeout(
        () => finish(new Error(`Plugin protocol stalled: ${errors}`)),
        10_000,
      )
      updates.on('message', check)
      check()
    })
  }
  const send = (value: unknown): void => {
    child.stdin.write(`${JSON.stringify(value)}\n`)
  }
  await take((message) => message['type'] === 'hello')
  send({ type: 'handshake', protocolVersion: 1 })
  await take((message) => message['type'] === 'ready')
  let sequence = 0
  const call = async (
    method: string,
    payload: unknown,
  ): Promise<Record<string, unknown>> => {
    const requestId = String(sequence++)
    send({
      protocolVersion: 1,
      requestId,
      capability: 'window.sync',
      method,
      payload,
      deadlineMs: 10_000,
    })
    const response = await take((message) => message['requestId'] === requestId)
    if (response['ok'] !== true) throw new Error(JSON.stringify(response['error']))
    return response['result'] as Record<string, unknown>
  }
  return { child, call, errors: () => errors }
}

async function terminal(
  plugin: Awaited<ReturnType<typeof start>>,
  id: unknown,
  signal: AbortSignal,
) {
  for (;;) {
    const status = await plugin.call('sync.status', { id })
    if (!['waiting', 'transferring'].includes(status['state'] as string)) return status
    await delay(10, undefined, { signal })
  }
}

async function portClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    socket.on('error', () => {
      resolve(true)
    })
    socket.on('connect', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

describe('built stdio processes', () => {
  it('moves an opaque encrypted file between two independent localhost plugin processes', async ({
    signal,
  }) => {
    const source = join(directory, 'archive.enc')
    const destination = join(directory, 'received.enc')
    await writeFile(source, Buffer.alloc(2 * 1024 * 1024 + 3, 0x9a))
    const sender = await start()
    const receiver = await start()
    const secret = 'd4'.repeat(32)
    const offer = await sender.call('sync.offer', { filePath: source, secret })
    const receipt = await holdReceipt(offer['invitation'] as string)
    const invitation = receipt.invitation
    const { jobId } = await receiver.call('sync.receive', {
      invitation,
      destination,
      host: '127.0.0.1',
    })
    const status = await terminal(receiver, jobId, signal)
    expect(status).toMatchObject({
      state: 'completed',
      path: destination,
      bytes: 2 * 1024 * 1024 + 3,
    })
    expect(await readFile(destination)).toEqual(await readFile(source))
    await receipt.held
    try {
      expect(await sender.call('sync.status', { id: offer['offerId'] })).toMatchObject({
        state: 'transferring',
      })
      receipt.release()
      expect(await terminal(sender, offer['offerId'], signal)).toMatchObject({
        state: 'completed',
      })
    } finally {
      receipt.release()
    }
    expect(sender.errors()).not.toContain(secret)
    expect(receiver.errors()).not.toContain(secret)
    expect((await readdir(directory)).filter((entry) => entry.endsWith('.part'))).toEqual(
      [],
    )
    const emitted = JSON.parse(
      await readFile(join(packageRoot, 'dist/nexus.plugin.json'), 'utf8'),
    ) as object
    expect(emitted).toMatchObject({
      id: 'studio.window-sync',
      name: '窗口同步',
      capabilities: ['window.sync'],
      permissions: {
        storage: 'private',
        wantsBrowserAccess: false,
        networkDomains: [],
        secrets: [],
      },
    })
  }, 30_000)

  it.each(['stdin', 'SIGTERM', 'SIGINT'] as const)(
    'closes a real listener on %s',
    async (action) => {
      const sender = await start()
      const source = join(directory, 'exit.enc')
      await writeFile(source, 'encrypted archive')
      const offer = await sender.call('sync.offer', {
        filePath: source,
        secret: 'e1'.repeat(32),
      })
      const invitation = JSON.parse(
        Buffer.from((offer['invitation'] as string).slice(11), 'base64url').toString(),
      ) as { port: number }
      expect(await portClosed(invitation.port)).toBe(false)
      const exited = once(sender.child, 'exit')
      if (action === 'stdin') sender.child.stdin.end()
      else sender.child.kill(action)
      const [code] = await exited
      expect(code).toBe(0)
      expect(await portClosed(invitation.port)).toBe(true)
    },
  )

  it('resolves an entry reached through a symlinked temporary parent directory', async () => {
    const linked = join(directory, 'linked-plugin')
    await symlink(packageRoot, linked, 'dir')
    const sender = await start(join(linked, 'dist/src/index.js'))
    const exited = once(sender.child, 'exit')
    sender.child.stdin.end()
    expect((await exited)[0]).toBe(0)
  })
})
