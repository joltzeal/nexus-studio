import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.each([
  ['http', false, false],
  ['https', false, false],
  ['http', true, false],
  ['https', true, false],
  ['http', false, true],
] as const)(
  'looks up online through an authenticated %s proxy (fallback=%s, rejected=%s)',
  async (protocol, fallback, rejected) => {
    const certificate = fileURLToPath(
      new URL('../fixtures/proxy-test.cert.pem', import.meta.url),
    )
    const tls = {
      cert: await readFile(certificate),
      key: await readFile(new URL('../fixtures/proxy-test.key.pem', import.meta.url)),
    }
    const sockets = new Set<Duplex>()
    const requests: string[] = []
    const credentials: string[] = []
    const geo = createHttpsServer(tls, (request, response) => {
      requests.push(request.headers.host!)
      if (fallback && request.headers.host === 'ipwho.is') {
        response.writeHead(429).end()
        return
      }
      response.end(
        JSON.stringify({
          success: true,
          ip: '81.2.69.160',
          country_code: 'GB',
          timezone:
            request.headers.host === 'ipwho.is'
              ? { id: 'Europe/London' }
              : 'Europe/London',
        }),
      )
    })
    const proxy = protocol === 'https' ? createHttpsServer(tls) : createHttpServer()
    for (const server of [geo, proxy]) {
      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
    }
    try {
      await new Promise<void>((resolve) => geo.listen(0, '127.0.0.1', resolve))
      const target = geo.address()
      if (!target || typeof target === 'string') throw new Error('Missing API listener')
      proxy.on('connect', (request, socket, head) => {
        credentials.push(request.headers['proxy-authorization'] ?? '')
        if (
          rejected ||
          request.headers['proxy-authorization'] !==
            `Basic ${Buffer.from('account:p@ss:word').toString('base64')}` ||
          !['ipwho.is:443', 'api.ip.sb:443'].includes(request.url ?? '')
        ) {
          socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
          return
        }
        const remote = connect(target.port, '127.0.0.1', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length) remote.write(head)
          socket.pipe(remote).pipe(socket)
        })
        sockets.add(remote)
        remote.on('close', () => sockets.delete(remote))
        remote.on('error', () => socket.destroy())
        socket.on('close', () => remote.destroy())
        socket.on('error', () => remote.destroy())
      })
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
      const address = proxy.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing proxy listener')
      const url = `${protocol}://account:p%40ss%3Aword@localhost:${address.port}`
      const module = new URL('../dist/online-proxy-geo.js', import.meta.url).href
      const result = await promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `globalThis.fetch = () => { throw new Error('No direct or database requests') };
           const {resolveOnlineProxyGeo} = await import(${JSON.stringify(module)});
           try {
             const geo = await resolveOnlineProxyGeo(${JSON.stringify(url)}, AbortSignal.timeout(5000));
             console.log(JSON.stringify(geo));
           } catch(error) { console.log(JSON.stringify({error:error.message})); }`,
        ],
        {
          env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
          timeout: 8000,
        },
      )
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual(
        rejected
          ? { error: 'PROFILE_GEO_PROXY_CONNECT_FAILED' }
          : { ip: '81.2.69.160', timezone: 'Europe/London', locale: 'en-GB' },
      )
      expect(requests).toEqual(
        rejected ? [] : fallback ? ['ipwho.is', 'api.ip.sb'] : ['ipwho.is'],
      )
      expect(credentials.length).toBeGreaterThan(0)
    } finally {
      for (const socket of sockets) socket.destroy()
      await Promise.all(
        [proxy, geo].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      )
    }
  },
)
