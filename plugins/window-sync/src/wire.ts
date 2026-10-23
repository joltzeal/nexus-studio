import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'
import {
  CHUNK_BYTES,
  isHex,
  MAX_HEADER_BYTES,
  record,
  SyncError,
  type Invitation,
} from './types.js'

export function sign(
  invitation: Invitation,
  role: 'sender' | 'receiver' | 'finished' | 'received',
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

export function verify(actual: unknown, expected: string): void {
  if (
    !isHex(actual, 32) ||
    !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
  ) {
    throw new SyncError('Peer authentication failed', 'AUTH_FAILED')
  }
}

/** One bounded read-ahead buffer; headers and raw archive bytes share the same TCP stream. */
export class Channel {
  private pending: Buffer = Buffer.alloc(0)

  constructor(readonly socket: Socket) {
    // Keep errors observed even between reads; waits still reject on close/error.
    socket.on('error', () => undefined)
  }

  private async readable(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.socket.off('readable', onReadable)
        this.socket.off('error', onError)
        this.socket.off('end', onEnd)
        this.socket.off('close', onEnd)
      }
      const onReadable = (): void => {
        cleanup()
        resolve()
      }
      const onError = (): void => {
        cleanup()
        reject(new SyncError('Peer connection failed', 'UNAVAILABLE'))
      }
      const onEnd = (): void => {
        cleanup()
        reject(new SyncError('Peer connection interrupted', 'UNAVAILABLE'))
      }
      this.socket.once('readable', onReadable)
      this.socket.once('error', onError)
      this.socket.once('end', onEnd)
      this.socket.once('close', onEnd)
      if (this.socket.destroyed || this.socket.readableEnded) onEnd()
    })
  }

  async chunk(maximum = CHUNK_BYTES): Promise<Buffer> {
    while (this.pending.length === 0) {
      const available = this.socket.read() as Buffer | null
      if (available !== null) this.pending = available
      else await this.readable()
    }
    const chunk = this.pending.subarray(0, Math.min(maximum, CHUNK_BYTES))
    this.pending = this.pending.subarray(chunk.length)
    return chunk
  }

  async line(): Promise<Record<string, unknown>> {
    const pieces: Buffer[] = []
    let length = 0
    for (;;) {
      const chunk = await this.chunk()
      const newline = chunk.indexOf(10)
      const piece = newline === -1 ? chunk : chunk.subarray(0, newline)
      length += piece.length
      if (length > MAX_HEADER_BYTES)
        throw new SyncError('Peer header exceeds limit', 'PROTOCOL_ERROR')
      pieces.push(piece)
      if (newline !== -1) {
        this.pending =
          this.pending.length === 0
            ? chunk.subarray(newline + 1)
            : Buffer.concat([chunk.subarray(newline + 1), this.pending])
        try {
          return record(JSON.parse(Buffer.concat(pieces, length).toString('utf8')))
        } catch {
          throw new SyncError('Invalid peer header', 'PROTOCOL_ERROR')
        }
      }
    }
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.socket.destroyed)
      throw new SyncError('Peer connection interrupted', 'UNAVAILABLE')
    await new Promise<void>((resolve, reject) => {
      const onClose = (): void => {
        this.socket.off('close', onClose)
        reject(new SyncError('Peer connection interrupted', 'UNAVAILABLE'))
      }
      this.socket.once('close', onClose)
      this.socket.write(chunk, (error) => {
        this.socket.off('close', onClose)
        if (error) reject(new SyncError('Peer write failed', 'UNAVAILABLE'))
        else resolve()
      })
    })
  }

  async send(value: unknown): Promise<void> {
    await this.write(Buffer.from(`${JSON.stringify(value)}\n`))
  }
}
