import { createHash, createHmac, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WindowSync } from './transport.js'
import { Channel } from './wire.js'

const SECRET = 'a7'.repeat(32)
const OTHER_SECRET = 'b8'.repeat(32)
type Invitation = {
  v: 1
  host: string
  port: number
  secret: string
  transferId: string
  sha256: string
  size: number
  expiresAt: number
}

function decode(invitation: string): Invitation {
  return JSON.parse(
    Buffer.from(invitation.slice(11), 'base64url').toString(),
  ) as Invitation
}

function encode(value: Invitation): string {
  return `nexus-sync:${Buffer.from(JSON.stringify(value)).toString('base64url')}`
}

// Independent peer implementation: changes to role/transcript binding must break interoperability.
function proof(
  invitation: Invitation,
  role: string,
  clientNonce: string,
  serverNonce: string,
): string {
  return createHmac('sha256', Buffer.from(invitation.secret, 'hex'))
    .update(
      JSON.stringify([
        'nexus-window-sync',
        1,
        role,
        invitation.transferId,
        invitation.sha256,
        invitation.size,
        invitation.expiresAt,
        clientNonce,
        serverNonce,
      ]),
    )
    .digest('hex')
}

async function line(socket: Socket): Promise<Record<string, unknown>> {
  let result = ''
  for (;;) {
    const byte = socket.read(1) as Buffer | null
    if (byte === null) {
      if (socket.destroyed || socket.readableEnded) throw new Error('Peer closed')
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          socket.off('readable', readable)
          socket.off('close', closed)
        }
        const readable = (): void => {
          cleanup()
          resolve()
        }
        const closed = (): void => {
          cleanup()
          reject(new Error('Peer closed'))
        }
        socket.once('readable', readable)
        socket.once('close', closed)
      })
      continue
    }
    if (byte[0] === 10) return JSON.parse(result) as Record<string, unknown>
    result += byte.toString()
    if (result.length > 4096) throw new Error('Oversized test peer line')
  }
}

function closed(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()))
}

function send(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`)
}

async function authenticate(socket: Socket, invitation: Invitation): Promise<void> {
  const clientNonce = randomBytes(32).toString('hex')
  send(socket, {
    type: 'request',
    v: 1,
    transferId: invitation.transferId,
    nonce: clientNonce,
  })
  const challenge = await line(socket)
  expect(challenge['type']).toBe('challenge')
  const serverNonce = challenge['nonce'] as string
  expect(challenge['proof']).toBe(proof(invitation, 'sender', clientNonce, serverNonce))
  send(socket, {
    type: 'authenticate',
    proof: proof(invitation, 'receiver', clientNonce, serverNonce),
  })
}

let directory: string
const instances: WindowSync[] = []
const sockets: Socket[] = []
const servers: Server[] = []

function instance(options: ConstructorParameters<typeof WindowSync>[0] = {}): WindowSync {
  const service = new WindowSync({
    addresses: () => ['127.0.0.1'],
    networkTimeoutMs: 1000,
    ...options,
  })
  instances.push(service)
  return service
}

async function peer(invitation: Invitation): Promise<Socket> {
  const socket = connect({ host: '127.0.0.1', port: invitation.port })
  sockets.push(socket)
  socket.on('error', () => undefined)
  await once(socket, 'connect')
  return socket
}

async function terminal(service: WindowSync, id: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = service.status({ id })
    if (['completed', 'failed', 'cancelled'].includes(status.state)) return status
    await delay(10)
  }
  throw new Error(`Job did not finish: ${JSON.stringify(service.status({ id }))}`)
}

async function archive(name = 'archive.enc', size = 250_017): Promise<string> {
  const path = join(directory, name)
  await writeFile(path, randomBytes(size))
  return path
}

async function fakeSender(
  handler: (
    socket: Socket,
    invitation: Invitation,
    sign: (role: string) => string,
  ) => Promise<void>,
  content = randomBytes(32_771),
  expiresAt = Date.now() + 900_000,
): Promise<Invitation> {
  const invitation: Invitation = {
    v: 1,
    host: '127.0.0.1',
    port: 0,
    secret: SECRET,
    transferId: randomBytes(16).toString('hex'),
    sha256: createHash('sha256').update(content).digest('hex'),
    size: content.length,
    expiresAt,
  }
  const server = createServer((socket) => {
    sockets.push(socket)
    socket.on('error', () => undefined)
    void (async () => {
      const request = await line(socket)
      const clientNonce = request['nonce'] as string
      const serverNonce = randomBytes(32).toString('hex')
      send(socket, {
        type: 'challenge',
        nonce: serverNonce,
        proof: proof(invitation, 'sender', clientNonce, serverNonce),
      })
      const auth = await line(socket)
      expect(auth['proof']).toBe(proof(invitation, 'receiver', clientNonce, serverNonce))
      send(socket, { type: 'data', size: content.length, sha256: invitation.sha256 })
      await handler(socket, invitation, (role) =>
        proof(invitation, role, clientNonce, serverNonce),
      )
    })().catch(() => socket.destroy())
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  invitation.port = (server.address() as { port: number }).port
  return invitation
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nexus-sync-'))
})

afterEach(async () => {
  vi.useRealTimers()
  for (const socket of sockets.splice(0)) socket.destroy()
  await Promise.all(instances.splice(0).map((service) => service.close()))
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  await rm(directory, { recursive: true, force: true })
})

describe('opaque archive transport over real TCP', () => {
  it('transfers between two instances and consumes the offer only after verified receipt', async () => {
    const sender = instance()
    const receiver = instance()
    const path = await archive()
    const offer = await sender.offer({ filePath: path, secret: SECRET })
    const invitation = decode(offer.invitation)
    expect(invitation).toMatchObject({
      v: 1,
      host: '127.0.0.1',
      secret: SECRET,
      size: 250_017,
      transferId: offer.offerId,
    })
    expect(offer.addresses).toEqual(['127.0.0.1'])
    expect(offer.expiresAt - Date.now()).toBeGreaterThan(899_000)
    expect(offer.expiresAt - Date.now()).toBeLessThanOrEqual(900_000)
    const destination = join(directory, 'received.enc')
    const { jobId } = await receiver.receive({
      invitation: offer.invitation,
      destination,
      host: '127.0.0.1',
    })
    expect(await terminal(receiver, jobId)).toEqual({
      state: 'completed',
      bytes: 250_017,
      total: 250_017,
      path: destination,
    })
    expect(await terminal(sender, offer.offerId)).toMatchObject({ state: 'completed' })
    expect(await readFile(destination)).toEqual(await readFile(path))
    expect(await readdir(directory)).toEqual(
      expect.arrayContaining(['received.enc', 'archive.enc']),
    )
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toEqual(
      [],
    )
    await expect(peer(invitation)).rejects.toThrow()
  })

  it.each([0, 65_536, 65_537])(
    'handles a %i-byte archive without frame ambiguity',
    async (size) => {
      const sender = instance()
      const receiver = instance()
      const path = await archive('size.enc', size)
      const offer = await sender.offer({ filePath: path, secret: SECRET })
      const destination = join(directory, 'output.enc')
      const { jobId } = await receiver.receive({
        invitation: offer.invitation,
        destination,
      })
      expect((await terminal(receiver, jobId)).state).toBe('completed')
      expect(await readFile(destination)).toEqual(await readFile(path))
    },
  )

  it('rejects a wrong secret without consuming the offer or disclosing archive bytes', async () => {
    const sender = instance()
    const receiver = instance()
    const offer = await sender.offer({ filePath: await archive(), secret: SECRET })
    const bad = { ...decode(offer.invitation), secret: OTHER_SECRET }
    const { jobId } = await receiver.receive({
      invitation: encode(bad),
      destination: join(directory, 'wrong.enc'),
    })
    expect(await terminal(receiver, jobId)).toMatchObject({ state: 'failed', bytes: 0 })
    expect(sender.status({ id: offer.offerId }).state).toBe('waiting')
    expect(await readdir(directory)).toEqual(['archive.enc'])
    const good = await receiver.receive({
      invitation: offer.invitation,
      destination: join(directory, 'correct.enc'),
    })
    expect((await terminal(receiver, good.jobId)).state).toBe('completed')
  })

  it('rejects a different transferId and reflected role proof', async () => {
    const sender = instance()
    const offer = await sender.offer({ filePath: await archive(), secret: SECRET })
    const invitation = decode(offer.invitation)
    const wrong = await peer(invitation)
    send(wrong, {
      type: 'request',
      v: 1,
      transferId: 'f0'.repeat(16),
      nonce: 'c0'.repeat(32),
    })
    await once(wrong, 'close')
    const reflected = await peer(invitation)
    send(reflected, {
      type: 'request',
      v: 1,
      transferId: invitation.transferId,
      nonce: 'c0'.repeat(32),
    })
    const challenge = await line(reflected)
    let disclosedBytes = 0
    reflected.on('data', (chunk: Buffer) => {
      disclosedBytes += chunk.length
    })
    send(reflected, { type: 'authenticate', proof: challenge['proof'] })
    await closed(reflected)
    expect(disclosedBytes).toBe(0)
    expect(sender.status({ id: offer.offerId })).toMatchObject({
      state: 'waiting',
      bytes: 0,
    })
  })

  it('allows a fresh attempt after an authenticated transfer is interrupted', async () => {
    const sender = instance()
    const receiver = instance()
    const offer = await sender.offer({
      filePath: await archive('large.enc', 8 * 1024 * 1024),
      secret: SECRET,
    })
    const invitation = decode(offer.invitation)
    const interrupted = await peer(invitation)
    await authenticate(interrupted, invitation)
    expect((await line(interrupted))['type']).toBe('data')
    interrupted.destroy()
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (sender.status({ id: offer.offerId }).state === 'waiting') break
      await delay(10)
    }
    expect(sender.status({ id: offer.offerId }).state).toBe('waiting')
    const { jobId } = await receiver.receive({
      invitation: offer.invitation,
      destination: join(directory, 'retried.enc'),
    })
    expect((await terminal(receiver, jobId)).state).toBe('completed')
  })

  it.each(['corruption', 'interruption', 'extra-bytes'])(
    'never publishes a destination on %s and removes its partial file',
    async (mode) => {
      const content = randomBytes(32_771)
      const invitation = await fakeSender(async (socket, _info, sign) => {
        const data = Buffer.from(content)
        if (mode === 'corruption') data[100] = data[100]! ^ 0xff
        if (mode === 'interruption') socket.end(data.subarray(0, 900))
        else {
          socket.write(data)
          if (mode === 'extra-bytes') socket.write('bad\n')
          send(socket, { type: 'finished', proof: sign('finished') })
          socket.end()
        }
      }, content)
      const receiver = instance()
      const { jobId } = await receiver.receive({
        invitation: encode(invitation),
        destination: join(directory, 'corrupt.enc'),
      })
      expect((await terminal(receiver, jobId)).state).toBe('failed')
      expect(await readdir(directory)).toEqual([])
    },
  )

  it('detects a source modified after offer creation', async () => {
    const sender = instance()
    const receiver = instance()
    const path = await archive()
    const offer = await sender.offer({ filePath: path, secret: SECRET })
    await writeFile(path, randomBytes(250_017))
    const { jobId } = await receiver.receive({
      invitation: offer.invitation,
      destination: join(directory, 'changed.enc'),
    })
    expect((await terminal(receiver, jobId)).state).toBe('failed')
    expect((await terminal(sender, offer.offerId)).state).toBe('failed')
    expect(await readdir(directory)).toEqual(['archive.enc'])
  })

  it('withholds completion if an already streamed source byte changes', async () => {
    const sender = instance()
    const path = await archive('mutating.enc', 8 * 1024 * 1024)
    const offer = await sender.offer({ filePath: path, secret: SECRET })
    const invitation = decode(offer.invitation)
    const socket = await peer(invitation)
    await authenticate(socket, invitation)
    expect((await line(socket))['type']).toBe('data')
    const file = await open(path, 'r+')
    await file.write(Buffer.from('changed'), 0, 7, 0)
    await file.close()
    let tail = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]).subarray(-4096)
    })
    await closed(socket)
    expect((await terminal(sender, offer.offerId)).state).toBe('failed')
    expect(tail.toString()).not.toContain('"type":"finished"')
  })

  it('authenticates a routed host override without sending the pairing secret over TCP', async () => {
    const sender = instance()
    const receiver = instance()
    const offer = await sender.offer({
      filePath: await archive('opaque.enc', 900),
      secret: SECRET,
    })
    const original = decode(offer.invitation)
    let outbound = ''
    let inboundHeaders = ''
    const relay = createServer((client) => {
      const upstream = connect({ host: '127.0.0.1', port: original.port })
      sockets.push(client, upstream)
      client.on('error', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
      client.on('data', (chunk: Buffer) => {
        outbound += chunk.toString()
      })
      upstream.on('data', (chunk: Buffer) => {
        inboundHeaders = (inboundHeaders + chunk.toString()).slice(0, 4096)
      })
      client.pipe(upstream).pipe(client)
    })
    servers.push(relay)
    relay.listen(0, '127.0.0.1')
    await once(relay, 'listening')
    const routed = {
      ...original,
      port: (relay.address() as { port: number }).port,
      host: 'unrouted.invalid',
    }
    const { jobId } = await receiver.receive({
      invitation: encode(routed),
      destination: join(directory, 'routed.enc'),
      host: '127.0.0.1',
    })
    expect((await terminal(receiver, jobId)).state).toBe('completed')
    expect(outbound).not.toContain(SECRET)
    expect(inboundHeaders).not.toContain(SECRET)
    expect(outbound).not.toContain('"secret"')
  })

  it('returns a job immediately for a stalled sender and fails it on a bounded timeout', async () => {
    const receiver = instance({ networkTimeoutMs: 50 })
    const invitation = await fakeSender(async () => undefined)
    const { jobId } = await receiver.receive({
      invitation: encode(invitation),
      destination: join(directory, 'stalled.enc'),
    })
    expect(receiver.status({ id: jobId }).state).toBe('waiting')
    expect((await terminal(receiver, jobId)).state).toBe('failed')
    expect(await readdir(directory)).toEqual([])
  })

  it('expires an incoming stalled transfer and removes partial bytes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const receiver = instance({ networkTimeoutMs: 30_000 })
    const invitation = await fakeSender(async (socket) => {
      socket.write(Buffer.alloc(10))
    })
    const { jobId } = await receiver.receive({
      invitation: encode(invitation),
      destination: join(directory, 'expired.enc'),
    })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (receiver.status({ id: jobId }).bytes > 0) break
      await delay(10)
    }
    expect(receiver.status({ id: jobId }).bytes).toBe(10)
    await vi.advanceTimersByTimeAsync(900_001)
    expect(await terminal(receiver, jobId)).toMatchObject({
      state: 'failed',
      error: 'Transfer expired',
      bytes: 10,
    })
    expect(await readdir(directory)).toEqual([])
  })

  it('rejects changed signed invitation metadata even with the right pairing secret', async () => {
    const sender = instance()
    const receiver = instance()
    const offer = await sender.offer({ filePath: await archive(), secret: SECRET })
    const invitation = decode(offer.invitation)
    const { jobId } = await receiver.receive({
      invitation: encode({ ...invitation, sha256: '00'.repeat(32) }),
      destination: join(directory, 'metadata.enc'),
    })
    expect(await terminal(receiver, jobId)).toMatchObject({ state: 'failed', bytes: 0 })
    expect(sender.status({ id: offer.offerId }).state).toBe('waiting')
    expect(await readdir(directory)).toEqual(['archive.enc'])
  })

  it('refuses a second authenticated receiver while an attempt awaits its receipt', async () => {
    const sender = instance()
    const receiver = instance()
    const offer = await sender.offer({
      filePath: await archive('exclusive.enc', 8 * 1024 * 1024),
      secret: SECRET,
    })
    const invitation = decode(offer.invitation)
    const first = await peer(invitation)
    await authenticate(first, invitation)
    expect((await line(first))['type']).toBe('data')
    const { jobId } = await receiver.receive({
      invitation: offer.invitation,
      destination: join(directory, 'second.enc'),
    })
    expect(await terminal(receiver, jobId)).toMatchObject({ state: 'failed', bytes: 0 })
    expect(sender.status({ id: offer.offerId }).state).toBe('transferring')
    expect(await readdir(directory)).toEqual(['exclusive.enc'])
    first.destroy()
  })

  it('cancels an active sender socket and permits no partial destination', async () => {
    const sender = instance()
    const receiver = instance()
    const offer = await sender.offer({
      filePath: await archive('cancel-source.enc', 8 * 1024 * 1024),
      secret: SECRET,
    })
    const { jobId } = await receiver.receive({
      invitation: offer.invitation,
      destination: join(directory, 'cancel-output.enc'),
    })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (sender.status({ id: offer.offerId }).bytes > 0) break
      await delay(1)
    }
    expect(await sender.cancel({ id: offer.offerId })).toEqual({ success: true })
    expect(sender.status({ id: offer.offerId }).state).toBe('cancelled')
    expect((await terminal(receiver, jobId)).state).toBe('failed')
    expect(await readdir(directory)).toEqual(['cancel-source.enc'])
  })

  it('keeps the original inode if its source path is replaced', async () => {
    const sender = instance()
    const receiver = instance()
    const path = await archive()
    const original = await readFile(path)
    const offer = await sender.offer({ filePath: path, secret: SECRET })
    await rm(path)
    await writeFile(path, 'replacement')
    const { jobId } = await receiver.receive({
      invitation: offer.invitation,
      destination: join(directory, 'pinned.enc'),
    })
    // Removing the original link changes ctime; refusing it is also a safe immutable-source policy.
    const status = await terminal(receiver, jobId)
    if (status.state === 'completed') {
      expect(await readFile(join(directory, 'pinned.enc'))).toEqual(original)
    } else {
      expect(status.state).toBe('failed')
      await expect(lstat(join(directory, 'pinned.enc'))).rejects.toThrow()
    }
  })

  it('preserves a destination that appears during reception', async () => {
    const content = randomBytes(32_771)
    const destination = join(directory, 'raced.enc')
    const invitation = await fakeSender(async (socket, _info, sign) => {
      await writeFile(destination, 'keep me')
      socket.write(content)
      send(socket, { type: 'finished', proof: sign('finished') })
    }, content)
    const receiver = instance()
    const { jobId } = await receiver.receive({
      invitation: encode(invitation),
      destination,
    })
    expect((await terminal(receiver, jobId)).state).toBe('failed')
    expect(await readFile(destination, 'utf8')).toBe('keep me')
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toEqual(
      [],
    )
  })

  it('cancels both listener and partial reception and returns stable terminal states', async () => {
    const sender = instance()
    const offer = await sender.offer({ filePath: await archive(), secret: SECRET })
    expect(await sender.cancel({ id: offer.offerId })).toEqual({ success: true })
    expect(sender.status({ id: offer.offerId }).state).toBe('cancelled')
    await expect(peer(decode(offer.invitation))).rejects.toThrow()
    const invitation = await fakeSender(async (socket) => {
      socket.write(Buffer.alloc(10))
    })
    const receiver = instance()
    const { jobId } = await receiver.receive({
      invitation: encode(invitation),
      destination: join(directory, 'cancelled.enc'),
    })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (receiver.status({ id: jobId }).bytes > 0) break
      await delay(10)
    }
    expect(receiver.status({ id: jobId }).bytes).toBeGreaterThan(0)
    expect(await receiver.cancel({ id: jobId })).toEqual({ success: true })
    expect(receiver.status({ id: jobId }).state).toBe('cancelled')
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toEqual(
      [],
    )
    expect(await receiver.cancel({ id: jobId })).toEqual({ success: true })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a real partial-file cleanup failure instead of claiming cancellation succeeded',
    async () => {
      const invitation = await fakeSender(async (socket) => {
        socket.write(Buffer.alloc(10))
      })
      const receiver = instance()
      const { jobId } = await receiver.receive({
        invitation: encode(invitation),
        destination: join(directory, 'permission.enc'),
      })
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (receiver.status({ id: jobId }).bytes > 0) break
        await delay(5)
      }
      expect(receiver.status({ id: jobId }).bytes).toBeGreaterThan(0)
      await chmod(directory, 0o500)
      try {
        await expect(receiver.cancel({ id: jobId })).rejects.toThrow(
          'Partial archive cleanup failed',
        )
        expect(receiver.status({ id: jobId })).toMatchObject({
          state: 'failed',
          error: 'Partial archive cleanup failed',
        })
      } finally {
        await chmod(directory, 0o700)
      }
    },
  )

  it('expires offers at 15 minutes and closes idle sockets', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const sender = instance({ networkTimeoutMs: 2_000_000 })
    const offer = await sender.offer({ filePath: await archive(), secret: SECRET })
    const socket = await peer(decode(offer.invitation))
    const connectionClosed = closed(socket)
    await vi.advanceTimersByTimeAsync(900_001)
    await connectionClosed
    expect(sender.status({ id: offer.offerId })).toMatchObject({ state: 'failed' })
    await expect(peer(decode(offer.invitation))).rejects.toThrow()
  })

  it('bounds untrusted headers and unauthenticated idle peers', async () => {
    const sender = instance({ networkTimeoutMs: 50 })
    const offer = await sender.offer({ filePath: await archive(), secret: SECRET })
    const oversized = await peer(decode(offer.invitation))
    oversized.write('x'.repeat(4097))
    await once(oversized, 'close')
    const idle = await peer(decode(offer.invitation))
    await once(idle, 'close')
    expect(sender.status({ id: offer.offerId }).state).toBe('waiting')
  })

  it('rejects invalid paths, secrets, invitations, hosts and unknown status ids', async () => {
    const service = instance()
    const path = await archive()
    for (const secret of ['bad', SECRET.toUpperCase(), `${SECRET} `]) {
      await expect(service.offer({ filePath: path, secret })).rejects.toThrow()
    }
    for (const filePath of ['relative.enc', directory]) {
      await expect(service.offer({ filePath, secret: SECRET })).rejects.toThrow()
    }
    const linkPath = join(directory, 'symlink.enc')
    await symlink(path, linkPath)
    await expect(service.offer({ filePath: linkPath, secret: SECRET })).rejects.toThrow()
    const offer = await service.offer({ filePath: path, secret: SECRET })
    for (const host of [
      'http://127.0.0.1',
      'user@host',
      'host:80',
      ' a ',
      '-bad.example',
    ]) {
      await expect(
        service.receive({
          invitation: offer.invitation,
          destination: join(directory, 'host.enc'),
          host,
        }),
      ).rejects.toThrow()
    }
    for (const invitation of [
      'bad',
      encode({ ...decode(offer.invitation), expiresAt: Date.now() - 1 }),
      encode({ ...decode(offer.invitation), size: -1 }),
      encode({ ...decode(offer.invitation), v: 2 } as unknown as Invitation),
    ]) {
      await expect(
        service.receive({
          invitation,
          destination: join(directory, 'bad.enc'),
        }),
      ).rejects.toThrow()
    }
    for (const destination of [
      path,
      linkPath,
      'relative.enc',
      join(directory, 'missing', 'file.enc'),
    ]) {
      await expect(
        service.receive({ invitation: offer.invitation, destination }),
      ).rejects.toThrow()
    }
    expect(() => service.status({ id: 'unknown' })).toThrow()
    await expect(service.cancel({ id: 'unknown' })).rejects.toThrow()
  })

  it('streams a large sparse archive with bounded buffers and backpressure', async () => {
    const sender = instance({ networkTimeoutMs: 30_000 })
    const receiver = instance({ networkTimeoutMs: 30_000 })
    const path = join(directory, 'stream.enc')
    const file = await open(path, 'wx')
    const size = 8 * 1024 * 1024 + 17
    await file.truncate(size)
    await file.close()
    let writeQueued!: (socket: Socket) => void
    const queued = new Promise<Socket>((resolve) => {
      writeQueued = resolve
    })
    const write = Channel.prototype.write
    let blocked: Socket | undefined
    let largestBackingBuffer = 0
    const writes = vi.spyOn(Channel.prototype, 'write').mockImplementation(function (
      this: Channel,
      chunk: Uint8Array,
    ) {
      largestBackingBuffer = Math.max(largestBackingBuffer, chunk.buffer.byteLength)
      if (!blocked && chunk.byteLength >= 65_536) {
        // A real corked socket holds the write callback until the test releases it.
        blocked = this.socket
        blocked.cork()
        writeQueued(blocked)
      }
      return write.call(this, chunk)
    })
    try {
      const offer = await sender.offer({ filePath: path, secret: SECRET })
      const destination = join(directory, 'streamed.enc')
      const { jobId } = await receiver.receive({
        invitation: offer.invitation,
        destination,
      })
      const socket = await queued
      await nextTurn()
      expect(sender.status({ id: offer.offerId })).toMatchObject({
        state: 'transferring',
        bytes: 0,
      })
      expect(socket.writableLength).toBe(65_536)
      socket.uncork()
      expect((await terminal(receiver, jobId, 30_000)).state).toBe('completed')
      expect((await terminal(sender, offer.offerId)).state).toBe('completed')
      expect((await lstat(destination)).size).toBe(size)
      const hash = createHash('sha256')
      const source = (await import('node:fs')).createReadStream(destination)
      for await (const chunk of source) hash.update(chunk as Buffer)
      expect(hash.digest('hex')).toBe(decode(offer.invitation).sha256)
      expect(largestBackingBuffer).toBeLessThanOrEqual(65_536)
    } finally {
      blocked?.uncork()
      writes.mockRestore()
    }
  }, 40_000)
})
