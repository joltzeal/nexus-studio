import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const servers: Server[] = []
const sockets = new Set<Socket>()
const socketErrors: Error[] = []
const preload = fileURLToPath(new URL('./network-preload.ts', import.meta.url))

function trackSocket(socket: Socket) {
  sockets.add(socket)
  socket.on('error', (error: NodeJS.ErrnoException) => {
    // Timeout and cancellation tests intentionally reset their peer connections.
    if (error.code !== 'ECONNRESET') socketErrors.push(error)
  })
  socket.once('close', () => sockets.delete(socket))
  return socket
}

async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.on('connection', trackSocket)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No listener')
  return address.port
}

afterEach(async () => {
  const closingSockets = [...sockets].map(
    (socket) =>
      new Promise<void>((resolve) => {
        socket.once('close', () => resolve())
        socket.destroy()
      }),
  )
  await Promise.all([
    ...closingSockets,
    ...servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  ])
  expect(socketErrors.splice(0), 'Unexpected test server socket errors').toEqual([])
})

async function runChild(proxy: string, script: string) {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      preload,
      '--input-type=module',
      '-e',
      `import { getGlobalDispatcher } from 'undici'
       try { ${script} }
       catch (error) { console.error(error); process.exitCode = 1 }
       finally { await getGlobalDispatcher().destroy() }`,
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, NEXUS_NETWORK_PROXY: proxy },
    },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString()
  })
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString()
  })
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    },
  )
}

async function fetchFromChild(proxy: string, target: string): Promise<number> {
  const result = await runChild(
    proxy,
    `
    const response = await fetch(${JSON.stringify(target)})
    if (!response.ok || await response.text() !== 'through proxy') process.exitCode = 2
  `,
  )
  return result.code
}

type Route = 'direct' | 'http' | 'socks5'

async function routeTo(origin: number, route: Route) {
  let connections = 0
  if (route === 'direct') return { proxy: '', connections: () => connections }
  const tunnel = (client: Duplex, ready: () => void) => {
    connections++
    const remote = trackSocket(
      connect(origin, '127.0.0.1', () => {
        ready()
        client.pipe(remote)
        remote.pipe(client)
      }),
    )
    client.on('close', () => remote.destroy())
    remote.on('error', () => client.destroy())
  }
  if (route === 'http') {
    const server = createHttpServer()
    server.on('connect', (_request, client) => {
      tunnel(client, () => client.write('HTTP/1.1 200 Connection Established\r\n\r\n'))
    })
    const port = await listen(server)
    return { proxy: `http://127.0.0.1:${port}`, connections: () => connections }
  }
  const port = await listen(
    createServer((client) => {
      client.once('data', () => {
        client.write(Buffer.from([5, 0]))
        client.once('data', () => {
          tunnel(client, () =>
            client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])),
          )
        })
      })
    }),
  )
  return { proxy: `socks5://127.0.0.1:${port}`, connections: () => connections }
}

it('cleans up a test server connection reset by a cancelled peer', async () => {
  let onClose: (hadError: boolean) => void = () => {}
  const closed = new Promise<boolean>((resolve) => {
    onClose = resolve
  })
  const port = await listen(
    createServer((socket) => {
      socket.once('close', onClose)
      socket.write('ready to cancel')
    }),
  )
  const client = connect(port, '127.0.0.1')
  client.once('data', () => client.resetAndDestroy())
  try {
    expect(await closed).toBe(true)
    expect(sockets.size).toBe(0)
  } finally {
    client.destroy()
  }
})

describe('application SOCKS5 proxy', () => {
  it.each([
    ['http://activation.example.test/validate', 80],
    ['https://activation.example.test/validate', 443],
    ['https://activation.example.test:443/validate', 443],
    ['https://activation.example.test:8443/validate', 8443],
  ])('requests the correct destination port for %s', async (target, expectedPort) => {
    let destinationPort: number | undefined
    const proxy = await listen(
      createServer((client) => {
        client.once('data', () => {
          client.write(Buffer.from([5, 0]))
          client.once('data', (request) => {
            destinationPort = request.readUInt16BE(request.length - 2)
            // Refuse locally after observing the real SOCKS handshake.
            client.end(Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 0]))
          })
        })
      }),
    )
    expect(await fetchFromChild(`socks5://127.0.0.1:${proxy}`, target)).toBe(1)
    expect(destinationPort).toBe(expectedPort)
  })

  it('routes fetch through the selected proxy and fails closed if it is unavailable', async () => {
    const origin = await listen(
      createHttpServer((_request, response) => {
        response.end('through proxy')
      }),
    )
    let connections = 0
    const proxy = await listen(
      createServer((client) => {
        client.once('data', (greeting) => {
          if (greeting[0] !== 5) return client.destroy()
          client.write(Buffer.from([5, 0]))
          client.once('data', (request) => {
            if (request[0] !== 5 || request[1] !== 1) return client.destroy()
            connections++
            const remote = trackSocket(
              connect(origin, '127.0.0.1', () => {
                client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
                client.pipe(remote)
                remote.pipe(client)
              }),
            )
            client.on('close', () => remote.destroy())
            remote.on('error', () => client.destroy())
          })
        })
      }),
    )
    const target = `http://127.0.0.1:${origin}/`
    expect(await fetchFromChild(`socks5://127.0.0.1:${proxy}`, target)).toBe(0)
    expect(connections).toBe(1)
    expect(await fetchFromChild('socks5://127.0.0.1:1', target)).toBe(1)
  })
})

describe.each<Route>(['direct', 'http', 'socks5'])('long requests over %s', (route) => {
  it.each([false, true])(
    'sets finite transport budgets beyond 60 minutes; fetch override: %s',
    async (override) => {
      let posts = 0
      const origin = await listen(
        createHttpServer((request, response) => {
          if (request.method === 'POST') posts++
          response.end('through proxy')
        }),
      )
      const transport = await routeTo(origin, route)
      const result = await runChild(
        transport.proxy,
        `
      const { channel } = await import('node:diagnostics_channel')
      const requests = []
      channel('undici:request:create').subscribe(({ request }) => {
        if (request.method === 'POST') requests.push({
          headersTimeout: request.headersTimeout,
          bodyTimeout: request.bodyTimeout
        })
      })
      const selected = getGlobalDispatcher()
      const dispatcher = ${override} ? {
        dispatch(options, handler) {
          return selected.dispatch({ ...options, headersTimeout: 300000, bodyTimeout: 300000 }, handler)
        }
      } : selected
      const response = await fetch('http://127.0.0.1:${origin}/image', {
        method: 'POST', body: 'synthetic image request',
        signal: AbortSignal.timeout(3600000), dispatcher
      })
      console.log(JSON.stringify({ body: await response.text(), requests }))
    `,
      )
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        body: 'through proxy',
        requests: [{ headersTimeout: 3_900_000, bodyTimeout: 3_900_000 }],
      })
      expect(posts).toBe(1)
      expect(transport.connections()).toBe(route === 'direct' ? 0 : 1)
    },
  )

  it.each(['headers', 'stream'] as const)(
    'bounds total duration while waiting for %s without a caller signal',
    async (phase) => {
      let posts = 0
      const origin = await listen(
        createHttpServer((request, response) => {
          if (request.method === 'POST') posts++
          if (phase === 'stream') {
            response.writeHead(200, { 'content-type': 'text/event-stream' })
            response.write('data: first\n\n')
            const timer = setInterval(() => response.write(': heartbeat\n\n'), 10)
            response.on('close', () => clearInterval(timer))
          }
        }),
      )
      const transport = await routeTo(origin, route)
      const result = await runChild(
        transport.proxy,
        `
      const { requestTimeoutPolicy } = await import(${JSON.stringify(preload)})
      const dispatcher = getGlobalDispatcher().compose(requestTimeoutPolicy(120))
      try {
        const response = await fetch('http://127.0.0.1:${origin}/image', {
          method: 'POST', body: 'synthetic image request', dispatcher
        })
        await response.text()
        throw new Error('Expected a total deadline')
      } catch (error) {
        console.log(JSON.stringify({ name: error.cause?.name ?? error.name }))
      }
    `,
      )
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ name: 'TimeoutError' })
      expect(posts).toBe(1)
      expect(transport.connections()).toBe(route === 'direct' ? 0 : 1)
    },
  )

  it.each(['init', 'request'] as const)(
    'keeps the earlier caller AbortSignal supplied via %s',
    async (signalSource) => {
      let posts = 0
      const origin = await listen(
        createHttpServer((request) => {
          if (request.method === 'POST') posts++
        }),
      )
      const transport = await routeTo(origin, route)
      const result = await runChild(
        transport.proxy,
        `
      const url = 'http://127.0.0.1:${origin}/image'
      const init = { method: 'POST', body: 'synthetic image request', signal: AbortSignal.timeout(120) }
      try {
        await (${JSON.stringify(signalSource)} === 'request' ? fetch(new Request(url, init)) : fetch(url, init))
        throw new Error('Expected caller timeout')
      } catch (error) {
        console.log(JSON.stringify({ name: error.name }))
      }
    `,
      )
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ name: 'TimeoutError' })
      expect(posts).toBe(1)
    },
  )

  it('does not replay a POST after the upstream connection closes', async () => {
    let posts = 0
    const origin = await listen(
      createHttpServer((request, response) => {
        if (request.method === 'POST') posts++
        request.resume()
        request.on('end', () => response.destroy())
      }),
    )
    const transport = await routeTo(origin, route)
    const result = await runChild(
      transport.proxy,
      `
      try {
        await fetch('http://127.0.0.1:${origin}/image', {
          method: 'POST', body: 'synthetic image request', signal: AbortSignal.timeout(1000)
        })
        throw new Error('Expected transport failure')
      } catch (error) {
        console.log(error.name)
      }
    `,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('TypeError')
    expect(posts).toBe(1)
    expect(transport.connections()).toBe(route === 'direct' ? 0 : 1)
  })
})

it.each(['http', 'socks5'] as const)(
  'does not fall back to direct when the selected %s proxy is unavailable',
  async (protocol) => {
    let received = 0
    const origin = await listen(
      createHttpServer((_request, response) => {
        received++
        response.end('through proxy')
      }),
    )
    expect(
      await fetchFromChild(`${protocol}://127.0.0.1:1`, `http://127.0.0.1:${origin}/`),
    ).toBe(1)
    expect(received).toBe(0)
  },
)

it('expires queued work before it can send a late POST', async () => {
  const methods: string[] = []
  const origin = await listen(
    createHttpServer((request, response) => {
      methods.push(request.method ?? '')
      response.writeHead(200)
      response.write('hold the only connection')
    }),
  )
  const result = await runChild(
    '',
    `
    const { Agent } = await import('undici')
    const { setTimeout: delay } = await import('node:timers/promises')
    const { requestTimeoutPolicy } = await import(${JSON.stringify(preload)})
    const agent = new Agent({ connections: 1 })
    try {
      const first = await fetch('http://127.0.0.1:${origin}/hold', { dispatcher: agent })
      try {
        await fetch('http://127.0.0.1:${origin}/image', {
          method: 'POST', body: 'must not be sent',
          dispatcher: agent.compose(requestTimeoutPolicy(80))
        })
        throw new Error('Expected queue deadline')
      } catch (error) {
        console.log(JSON.stringify({ name: error.cause?.name ?? error.name }))
      }
      await first.body.cancel()
      await delay(50)
    } finally {
      await agent.destroy()
    }
  `,
  )
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ name: 'TimeoutError' })
  expect(methods).toEqual(['GET'])
})

it('rejects disabled, non-finite and over-limit total deadlines', async () => {
  const result = await runChild(
    '',
    `
    const { requestTimeoutPolicy } = await import(${JSON.stringify(preload)})
    const names = [0, -1, NaN, Infinity, 3900001].map((timeout) => {
      try { requestTimeoutPolicy(timeout); return 'accepted' }
      catch (error) { return error.name }
    })
    console.log(JSON.stringify(names))
  `,
  )
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(Array(5).fill('RangeError'))
})
