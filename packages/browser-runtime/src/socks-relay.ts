import { createServer, Socket } from 'node:net'
import { SocksClient } from 'socks'

function readBytes(socket: Socket, count: number): Promise<Buffer> {
  if (count === 0) return Promise.resolve(Buffer.alloc(0))
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('readable', readable)
      socket.off('error', failed)
      socket.off('end', failed)
      socket.off('close', failed)
    }
    const failed = () => {
      cleanup()
      reject(new Error('PROFILE_PROXY_BRIDGE_FAILED'))
    }
    const readable = () => {
      const bytes = socket.read(count) as Buffer | null
      if (bytes !== null) {
        cleanup()
        resolve(bytes)
      } else if (socket.destroyed || socket.readableEnded) {
        failed()
      }
    }
    socket.on('readable', readable)
    socket.once('error', failed)
    socket.once('end', failed)
    socket.once('close', failed)
    readable()
  })
}

export async function startSocksRelay(
  proxy: string,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<{ url: string; close: () => Promise<void> }> {
  signal.throwIfAborted()
  const url = new URL(proxy)
  const userId = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const port = Number(url.port)
  if (
    !['socks5:', 'socks5h:'].includes(url.protocol) ||
    !hostname ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    Buffer.byteLength(userId) > 255 ||
    Buffer.byteLength(password) > 255
  ) {
    throw new Error('PROFILE_PROXY_BRIDGE_FAILED')
  }
  const sockets = new Set<Socket>()
  const track = (socket: Socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    return socket
  }
  const server = createServer((client) => {
    track(client)
    let upstream: Socket | undefined
    const timer = setTimeout(() => {
      client.destroy(new Error('PROFILE_PROXY_BRIDGE_FAILED'))
      upstream?.destroy(new Error('PROFILE_PROXY_BRIDGE_FAILED'))
    }, timeoutMs)
    client.once('close', () => {
      clearTimeout(timer)
      upstream?.destroy(new Error('PROFILE_PROXY_BRIDGE_FAILED'))
    })
    void (async () => {
      // Only the loopback hop is unauthenticated. Every destination is connected
      // through the original upstream SOCKS5 proxy with its complete credentials.
      const greeting = await readBytes(client, 2)
      const methods = await readBytes(client, greeting[1]!)
      if (greeting[0] !== 5 || !methods.includes(0)) {
        client.end(Buffer.from([5, 255]))
        return
      }
      client.write(Buffer.from([5, 0]))
      const request = await readBytes(client, 4)
      if (request[0] !== 5 || request[1] !== 1 || request[2] !== 0) {
        throw new Error('PROFILE_PROXY_BRIDGE_FAILED')
      }
      let host: string
      if (request[3] === 3) {
        const length = (await readBytes(client, 1))[0]!
        host = (await readBytes(client, length)).toString()
      } else if (request[3] === 1) {
        host = [...(await readBytes(client, 4))].join('.')
      } else if (request[3] === 4) {
        const bytes = await readBytes(client, 16)
        host = Array.from({ length: 8 }, (_, i) =>
          bytes.readUInt16BE(i * 2).toString(16),
        ).join(':')
      } else {
        throw new Error('PROFILE_PROXY_BRIDGE_FAILED')
      }
      const targetPort = (await readBytes(client, 2)).readUInt16BE()
      if (!host || host.includes('\0') || !targetPort) {
        throw new Error('PROFILE_PROXY_BRIDGE_FAILED')
      }
      upstream = track(new Socket())
      const socket = upstream
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.off('connect', connected)
          socket.off('error', failed)
          socket.off('close', failed)
        }
        const connected = () => {
          cleanup()
          resolve()
        }
        const failed = () => {
          cleanup()
          reject(new Error('PROFILE_PROXY_BRIDGE_FAILED'))
        }
        socket.once('connect', connected)
        socket.once('error', failed)
        socket.once('close', failed)
        socket.connect(port, hostname)
      })
      await SocksClient.createConnection({
        proxy: { host: hostname, port, type: 5, userId, password },
        command: 'connect',
        destination: { host, port: targetPort },
        existing_socket: socket,
        timeout: timeoutMs,
      })
      if (signal.aborted || client.destroyed) {
        throw new Error('PROFILE_PROXY_BRIDGE_FAILED')
      }
      clearTimeout(timer)
      client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
      socket.once('close', () => client.destroy())
      socket.pipe(client)
      client.pipe(socket)
    })().catch(() => {
      upstream?.destroy()
      clearTimeout(timer)
      if (!client.destroyed) {
        client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]), () => client.destroy())
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= new Promise<void>((resolve) => {
      signal.removeEventListener('abort', aborted)
      for (const socket of sockets) {
        socket.destroy(new Error('PROFILE_PROXY_BRIDGE_FAILED'))
      }
      server.close(() => resolve())
    })
    return closing
  }
  const aborted = () => {
    void close()
  }
  signal.addEventListener('abort', aborted, { once: true })
  server.on('error', aborted)
  if (signal.aborted) {
    await close()
    signal.throwIfAborted()
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    await close()
    throw new Error('PROFILE_PROXY_BRIDGE_FAILED')
  }
  return { url: `socks5://127.0.0.1:${address.port}`, close }
}
