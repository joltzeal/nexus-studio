import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, open, stat, unlink, type FileHandle } from 'node:fs/promises'
import { connect, createServer, isIPv4, type Server, type Socket } from 'node:net'
import { basename, dirname, join } from 'node:path'

import { fingerprint, hashArchive, openArchive, writeAll } from './archive.js'
import {
  absolutePath,
  decodeInvitation,
  encodeInvitation,
  hostName,
  lanAddresses,
} from './invitation.js'
import {
  CHUNK_BYTES,
  fields,
  isHex,
  OFFER_LIFETIME_MS,
  SyncError,
  terminal,
  type Invitation,
  type OfferResult,
  type SyncStatus,
} from './types.js'
import { Channel, sign, verify } from './wire.js'

export interface WindowSyncOptions {
  addresses?: () => string[]
  networkTimeoutMs?: number
  now?: () => number
}

interface Job {
  id: string
  kind: 'offer' | 'receive'
  expired: boolean
  status: SyncStatus
  abort: AbortController
  sockets: Set<Socket>
  tasks: Set<Promise<void>>
  timer?: ReturnType<typeof setTimeout>
  server?: Server
  file?: FileHandle
  cleanupFailure?: string
  release?: Promise<void>
}

export class WindowSync {
  private readonly jobs = new Map<string, Job>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly shutdown = new AbortController()
  private readonly now: () => number
  private readonly timeout: number
  private closeTask: Promise<void> | undefined

  constructor(private readonly options: WindowSyncOptions = {}) {
    this.now = options.now ?? Date.now
    this.timeout = options.networkTimeoutMs ?? 30_000
  }

  private alive(signal?: AbortSignal): void {
    if (this.shutdown.signal.aborted || signal?.aborted) {
      throw new SyncError('Operation cancelled', 'CANCELLED')
    }
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task)).catch(() => undefined)
    return task
  }

  private createJob(total: number, kind: Job['kind']): Job {
    this.alive()
    if ([...this.jobs.values()].filter((job) => !terminal(job.status)).length >= 16) {
      throw new SyncError('Too many active transfers', 'UNAVAILABLE')
    }
    if (this.jobs.size >= 256) {
      const oldest = [...this.jobs.values()].find((job) => terminal(job.status))
      if (oldest) this.jobs.delete(oldest.id)
    }
    const job: Job = {
      id: randomBytes(16).toString('hex'),
      kind,
      expired: false,
      status: { state: 'waiting', bytes: 0, total },
      abort: new AbortController(),
      sockets: new Set(),
      tasks: new Set(),
    }
    this.jobs.set(job.id, job)
    return job
  }

  private getJob(payload: unknown): Job {
    const input = fields(payload, ['id'])
    const job = typeof input['id'] === 'string' ? this.jobs.get(input['id']) : undefined
    if (!job) throw new SyncError('Unknown transfer id')
    return job
  }

  private expire(job: Job, expiresAt: number): void {
    job.timer = setTimeout(
      () => {
        if (terminal(job.status)) return
        job.expired = true
        if (job.kind === 'offer') {
          job.status.state = 'failed'
          job.status.error = 'Transfer expired'
        }
        job.abort.abort()
        void this.release(job)
      },
      Math.max(0, expiresAt - this.now()),
    )
    job.timer.unref()
  }

  private attach(job: Job, socket: Socket): Channel {
    job.sockets.add(socket)
    socket.once('close', () => job.sockets.delete(socket))
    socket.setNoDelay(true)
    socket.setTimeout(this.timeout, () => socket.destroy())
    return new Channel(socket)
  }

  private stopListening(job: Job): void {
    if (job.timer) clearTimeout(job.timer)
    if (job.server?.listening) job.server.close()
  }

  private release(job: Job): Promise<void> {
    job.release ??= (async () => {
      this.stopListening(job)
      for (const socket of job.sockets) socket.destroy()
      await Promise.allSettled([...job.tasks])
      try {
        await job.file?.close()
      } catch {
        job.cleanupFailure = 'Source archive close failed'
        job.status.state = 'failed'
        job.status.error = job.cleanupFailure
      }
      delete job.file
    })()
    return job.release
  }

  offer(payload: unknown, signal?: AbortSignal): Promise<OfferResult> {
    return this.track(this.createOffer(payload, signal))
  }

  private async createOffer(
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<OfferResult> {
    const input = fields(payload, ['filePath', 'secret'])
    const path = absolutePath(input['filePath'])
    if (!isHex(input['secret'], 32))
      throw new SyncError('Secret must be 64 lowercase hex characters')
    this.alive(signal)
    let file: FileHandle | undefined
    let job: Job | undefined
    try {
      file = await openArchive(path)
      const before = await file.stat({ bigint: true })
      const original = fingerprint(before)
      const sha256 = await hashArchive(file, () => this.alive(signal))
      if (original !== fingerprint(await file.stat({ bigint: true }))) {
        throw new SyncError('Source archive changed', 'SOURCE_CHANGED')
      }
      this.alive(signal)
      const addresses = [...new Set((this.options.addresses ?? lanAddresses)())]
      if (addresses.length === 0 || addresses.some((address) => !isIPv4(address))) {
        throw new SyncError('No valid local IPv4 address', 'UNAVAILABLE')
      }
      job = this.createJob(Number(before.size), 'offer')
      job.file = file
      const offer = job
      const invitation: Invitation = {
        v: 1,
        host: addresses[0]!,
        port: 0,
        secret: input['secret'],
        transferId: job.id,
        sha256,
        size: Number(before.size),
        expiresAt: this.now() + OFFER_LIFETIME_MS,
      }
      const server = createServer({ highWaterMark: CHUNK_BYTES }, (socket) => {
        if (
          offer.sockets.size >= 8 ||
          terminal(offer.status) ||
          offer.abort.signal.aborted
        ) {
          socket.destroy()
          return
        }
        const channel = this.attach(offer, socket)
        const task = this.serve(offer, channel, invitation, original)
        offer.tasks.add(task)
        void task
          .finally(() => {
            offer.tasks.delete(task)
            if (terminal(offer.status)) void this.release(offer)
          })
          .catch(() => undefined)
      })
      job.server = server
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '0.0.0.0', () => {
          server.off('error', reject)
          resolve()
        })
      })
      server.on('error', () => {
        if (!terminal(offer.status)) {
          offer.status.state = 'failed'
          offer.status.error = 'Listener failed'
          offer.abort.abort()
          void this.release(offer)
        }
      })
      this.alive(signal)
      invitation.port = (server.address() as { port: number }).port
      this.expire(job, invitation.expiresAt)
      return {
        offerId: job.id,
        invitation: encodeInvitation(invitation),
        addresses,
        expiresAt: invitation.expiresAt,
      }
    } catch (error) {
      if (job) {
        job.status.state = 'failed'
        this.stopListening(job)
        await this.release(job)
      } else await file?.close()
      if (error instanceof SyncError) throw error
      throw new SyncError('Cannot open archive or start listener', 'UNAVAILABLE')
    }
  }

  private async serve(
    job: Job,
    channel: Channel,
    invitation: Invitation,
    original: string,
  ): Promise<void> {
    let transferring = false
    const socket = channel.socket
    const handshakeTimer = setTimeout(
      () => socket.destroy(),
      Math.min(this.timeout, 15_000),
    )
    const alive = (): void => {
      this.alive(job.abort.signal)
      if (this.now() >= invitation.expiresAt) throw new SyncError('Transfer expired')
      if (socket.destroyed)
        throw new SyncError('Peer connection interrupted', 'UNAVAILABLE')
    }
    try {
      alive()
      const request = await channel.line()
      if (
        request['type'] !== 'request' ||
        request['v'] !== 1 ||
        request['transferId'] !== invitation.transferId ||
        !isHex(request['nonce'], 32)
      ) {
        throw new SyncError('Invalid peer request', 'AUTH_FAILED')
      }
      const clientNonce = request['nonce']
      const serverNonce = randomBytes(32).toString('hex')
      const proof = (role: Parameters<typeof sign>[1]): string =>
        sign(invitation, role, clientNonce, serverNonce)
      await channel.send({
        type: 'challenge',
        nonce: serverNonce,
        proof: proof('sender'),
      })
      const authentication = await channel.line()
      if (authentication['type'] !== 'authenticate')
        throw new SyncError('Peer authentication failed', 'AUTH_FAILED')
      verify(authentication['proof'], proof('receiver'))
      alive()
      if (job.status.state !== 'waiting')
        throw new SyncError('Offer is busy', 'UNAVAILABLE')
      transferring = true
      job.status.state = 'transferring'
      job.status.bytes = 0
      clearTimeout(handshakeTimer)
      const file = job.file!
      if (
        original !== fingerprint(await file.stat({ bigint: true })) ||
        (await hashArchive(file, alive)) !== invitation.sha256
      ) {
        throw new SyncError('Source archive changed', 'SOURCE_CHANGED')
      }
      await channel.send({
        type: 'data',
        size: invitation.size,
        sha256: invitation.sha256,
      })
      const streamedHash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
      while (job.status.bytes < invitation.size) {
        alive()
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, invitation.size - job.status.bytes),
          job.status.bytes,
        )
        if (bytesRead === 0)
          throw new SyncError('Source archive changed', 'SOURCE_CHANGED')
        const chunk = buffer.subarray(0, bytesRead)
        streamedHash.update(chunk)
        await channel.write(chunk)
        job.status.bytes += bytesRead
      }
      if (
        streamedHash.digest('hex') !== invitation.sha256 ||
        original !== fingerprint(await file.stat({ bigint: true })) ||
        (await hashArchive(file, alive)) !== invitation.sha256
      ) {
        throw new SyncError('Source archive changed', 'SOURCE_CHANGED')
      }
      alive()
      await channel.send({ type: 'finished', proof: proof('finished') })
      const receipt = await channel.line()
      if (receipt['type'] !== 'received')
        throw new SyncError('Missing receipt', 'PROTOCOL_ERROR')
      verify(receipt['proof'], proof('received'))
      alive()
      job.status.state = 'completed'
      this.stopListening(job)
    } catch (error) {
      if (!terminal(job.status) && transferring) {
        if (error instanceof SyncError && error.code === 'SOURCE_CHANGED') {
          job.status.state = 'failed'
          job.status.error = 'Source archive changed'
          this.stopListening(job)
        } else {
          job.status.state = 'waiting'
          job.status.bytes = 0
        }
      }
    } finally {
      clearTimeout(handshakeTimer)
      socket.destroy()
    }
  }

  receive(payload: unknown, signal?: AbortSignal): Promise<{ jobId: string }> {
    return this.track(this.createReceive(payload, signal))
  }

  private async createReceive(
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<{ jobId: string }> {
    const input = fields(payload, ['invitation', 'destination', 'host'])
    const invitation = decodeInvitation(input['invitation'], this.now())
    const destination = absolutePath(input['destination'])
    const host = input['host'] === undefined ? invitation.host : hostName(input['host'])
    this.alive(signal)
    try {
      try {
        await lstat(destination)
        throw new SyncError('Destination already exists')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (!(await stat(dirname(destination))).isDirectory())
        throw new SyncError('Destination parent must exist')
    } catch (error) {
      if (error instanceof SyncError) throw error
      throw new SyncError('Destination parent must exist and destination must not exist')
    }
    this.alive(signal)
    const job = this.createJob(invitation.size, 'receive')
    this.expire(job, invitation.expiresAt)
    const task = this.download(job, invitation, destination, host)
    job.tasks.add(task)
    void task
      .finally(() => {
        job.tasks.delete(task)
        if (job.timer) clearTimeout(job.timer)
      })
      .catch(() => undefined)
    return { jobId: job.id }
  }

  private async download(
    job: Job,
    invitation: Invitation,
    destination: string,
    host: string,
  ): Promise<void> {
    const temporary = join(
      dirname(destination),
      `.${basename(destination)}.${job.id}.part`,
    )
    let file: FileHandle | undefined
    let ownsTemporary = false
    let failure: string | undefined
    const socket = connect({ host, port: invitation.port })
    const channel = this.attach(job, socket)
    const handshakeTimer = setTimeout(
      () => socket.destroy(),
      Math.min(this.timeout, 15_000),
    )
    const alive = (): void => {
      this.alive(job.abort.signal)
      if (this.now() >= invitation.expiresAt) throw new SyncError('Transfer expired')
    }
    try {
      alive()
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', onConnect)
        socket.once('close', onClose)
        function cleanup(): void {
          socket.off('connect', onConnect)
          socket.off('close', onClose)
        }
        function onConnect(): void {
          cleanup()
          resolve()
        }
        function onClose(): void {
          cleanup()
          reject(new SyncError('Peer connection failed', 'UNAVAILABLE'))
        }
      })
      const clientNonce = randomBytes(32).toString('hex')
      await channel.send({
        type: 'request',
        v: 1,
        transferId: invitation.transferId,
        nonce: clientNonce,
      })
      const challenge = await channel.line()
      if (challenge['type'] !== 'challenge' || !isHex(challenge['nonce'], 32)) {
        throw new SyncError('Invalid peer challenge', 'AUTH_FAILED')
      }
      const proof = (role: Parameters<typeof sign>[1]): string =>
        sign(invitation, role, clientNonce, challenge['nonce'] as string)
      verify(challenge['proof'], proof('sender'))
      await channel.send({ type: 'authenticate', proof: proof('receiver') })
      clearTimeout(handshakeTimer)
      const header = await channel.line()
      if (
        header['type'] !== 'data' ||
        header['size'] !== invitation.size ||
        header['sha256'] !== invitation.sha256
      ) {
        throw new SyncError('Archive metadata mismatch', 'PROTOCOL_ERROR')
      }
      clearTimeout(handshakeTimer)
      alive()
      file = await open(temporary, 'wx', 0o600)
      ownsTemporary = true
      job.status.state = 'transferring'
      const hash = createHash('sha256')
      while (job.status.bytes < invitation.size) {
        alive()
        const chunk = await channel.chunk(invitation.size - job.status.bytes)
        hash.update(chunk)
        await writeAll(file, chunk)
        job.status.bytes += chunk.length
      }
      const finished = await channel.line()
      if (finished['type'] !== 'finished')
        throw new SyncError('Missing archive completion', 'PROTOCOL_ERROR')
      verify(finished['proof'], proof('finished'))
      if (hash.digest('hex') !== invitation.sha256)
        throw new SyncError('Archive checksum mismatch', 'PROTOCOL_ERROR')
      alive()
      await file.sync()
      await file.close()
      file = undefined
      alive()
      // Publish without replacement, then remove the private temporary name.
      await link(temporary, destination)
      await unlink(temporary)
      ownsTemporary = false
      job.status = {
        state: 'completed',
        bytes: invitation.size,
        total: invitation.size,
        path: destination,
      }
      await channel.send({ type: 'received', proof: proof('received') })
    } catch (error) {
      failure = job.expired
        ? 'Transfer expired'
        : job.abort.signal.aborted
          ? 'Transfer cancelled'
          : error instanceof SyncError
            ? error.message
            : 'Archive transfer or storage failed'
    } finally {
      clearTimeout(handshakeTimer)
      try {
        await file?.close()
      } catch {
        failure = 'Archive close failed'
        job.cleanupFailure = failure
      }
      if (ownsTemporary) {
        try {
          await unlink(temporary)
        } catch {
          failure = 'Partial archive cleanup failed'
          job.cleanupFailure = failure
        }
      }
      socket.destroy()
      if (job.status.state !== 'completed') {
        job.status.state =
          job.abort.signal.aborted && !job.expired && failure === 'Transfer cancelled'
            ? 'cancelled'
            : 'failed'
        job.status.error = failure ?? 'Archive transfer failed'
      }
    }
  }

  status(payload: unknown): SyncStatus {
    return { ...this.getJob(payload).status }
  }

  async cancel(payload: unknown): Promise<{ success: true }> {
    const job = this.getJob(payload)
    if (!terminal(job.status)) {
      job.abort.abort()
      await this.release(job)
      if (!terminal(job.status)) {
        job.status.state = 'cancelled'
        job.status.error = 'Transfer cancelled'
      }
    } else await this.release(job)
    if (job.cleanupFailure) throw new SyncError(job.cleanupFailure, 'UNAVAILABLE')
    return { success: true }
  }

  close(): Promise<void> {
    this.closeTask ??= (async () => {
      this.shutdown.abort()
      for (const job of this.jobs.values()) job.abort.abort()
      await Promise.allSettled(
        [...this.jobs.values()].map((job) => this.cancel({ id: job.id })),
      )
      await Promise.allSettled([...this.pending])
    })()
    return this.closeTask
  }
}
