import { createServer, connect, type Socket } from 'node:net'
import { SocksClient } from 'socks'
import { expect, it } from 'vitest'
import { startSocksRelay } from './socks-relay.js'

it.each([false, true])(
  'closes pending relay sockets and listener on abort (upstream handshake=%s)',
  async (handshake) => {
    const upstreamSockets = new Set<Socket>()
    const upstream = createServer((socket) => {
      upstreamSockets.add(socket)
      socket.on('close', () => upstreamSockets.delete(socket))
      socket.resume()
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('Listener missing')
    const controller = new AbortController()
    const relay = await startSocksRelay(
      `socks5://user:synthetic-password@127.0.0.1:${address.port}`,
      controller.signal,
    )
    const proxy = new URL(relay.url)
    let client: Socket | undefined
    let pending: Promise<unknown> | undefined
    try {
      if (handshake) {
        pending = SocksClient.createConnection({
          proxy: { host: proxy.hostname, port: Number(proxy.port), type: 5 },
          command: 'connect',
          destination: { host: 'nexus-relay.invalid', port: 443 },
          timeout: 2_000,
        }).catch((error: unknown) => error)
        await expect.poll(() => upstreamSockets.size).toBe(1)
      } else {
        client = connect(Number(proxy.port), proxy.hostname)
        client.on('error', () => {})
        await new Promise<void>((resolve) => client!.once('connect', resolve))
      }
      controller.abort()
      await relay.close()
      if (pending) expect(await pending).toBeInstanceOf(Error)
      if (client) await expect.poll(() => client!.destroyed).toBe(true)
      await expect.poll(() => upstreamSockets.size).toBe(0)
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = connect(Number(proxy.port), proxy.hostname, () => {
            socket.destroy()
            resolve()
          })
          socket.once('error', reject)
        }),
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    } finally {
      controller.abort()
      client?.destroy()
      await relay.close()
      for (const socket of upstreamSockets) socket.destroy()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  },
)

it('fails a stalled upstream handshake within its bound without contacting the destination directly', async () => {
  let directConnections = 0
  const destination = createServer((socket) => {
    directConnections++
    socket.destroy()
  })
  const sockets = new Set<Socket>()
  const upstream = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.resume()
  })
  await Promise.all([
    new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve)),
  ])
  const address = upstream.address()
  const target = destination.address()
  if (!address || !target || typeof address === 'string' || typeof target === 'string')
    throw new Error('Listener missing')
  const controller = new AbortController()
  const relay = await startSocksRelay(
    `socks5://user:synthetic-password@127.0.0.1:${address.port}`,
    controller.signal,
    100,
  )
  try {
    const proxy = new URL(relay.url)
    const start = performance.now()
    await expect(
      SocksClient.createConnection({
        proxy: { host: proxy.hostname, port: Number(proxy.port), type: 5 },
        command: 'connect',
        destination: { host: '127.0.0.1', port: target.port },
        timeout: 2_000,
      }),
    ).rejects.toBeInstanceOf(Error)
    expect(performance.now() - start).toBeLessThan(1_000)
    expect(directConnections).toBe(0)
  } finally {
    controller.abort()
    await relay.close()
    for (const socket of sockets) socket.destroy()
    await Promise.all([
      new Promise<void>((resolve) => upstream.close(() => resolve())),
      new Promise<void>((resolve) => destination.close(() => resolve())),
    ])
  }
})
