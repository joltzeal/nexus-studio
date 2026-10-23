import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import { connect as connectSocket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { parseBrowserVersion } from './profile-runtime.js'

const binary = process.env.NEXUS_TEST_BROWSER_BINARY

it
  .skipIf(!binary)
  .each(['none', 'simple', 'special', 'geoip', 'geoip-manual', 'geoip-fallback'])(
  'opens a real profile through SOCKS5 with complete upstream credentials (authentication=%s)',
  async (authentication) => {
    const authenticated = authentication !== 'none'
    const matching = authentication.startsWith('geoip')
    const manual = authentication === 'geoip-manual'
    const directory = await mkdtemp(join(tmpdir(), 'nexus-native-socks-'))
    const sockets = new Set<Duplex>()
    const authentications: { username: string; password: string }[] = []
    const requests: string[] = []
    const username = 'synthetic-user'
    const password =
      authentication === 'special' ? 'synthetic:p@ss=word' : 'synthetic-password'
    const hostname = 'nexus-socks-test.invalid'
    const body = `<html><script>
      fetch('/fingerprint?timezone='+encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)
        +'&locale='+encodeURIComponent(navigator.language));
    </script></html>`
    const certificate = fileURLToPath(
      new URL('../fixtures/proxy-test.cert.pem', import.meta.url),
    )
    let echoes = 0
    const https = createHttpsServer(
      {
        cert: await readFile(certificate),
        key: await readFile(new URL('../fixtures/proxy-test.key.pem', import.meta.url)),
      },
      (request, response) => {
        echoes++
        if (authentication === 'geoip-fallback' && request.headers.host === 'ipwho.is') {
          response.writeHead(429).end()
          return
        }
        response.end(
          request.headers.host === 'ipwho.is'
            ? JSON.stringify({
                success: true,
                ip: '81.2.69.160',
                country_code: 'GB',
                timezone: { id: 'Europe/London' },
              })
            : request.headers.host === 'api.ip.sb'
              ? JSON.stringify({
                  ip: '81.2.69.160',
                  country_code: 'GB',
                  timezone: 'Europe/London',
                })
              : '81.2.69.160',
        )
      },
    )
    https.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => https.listen(0, '127.0.0.1', resolve))
    const httpsAddress = https.address()
    if (!httpsAddress || typeof httpsAddress === 'string')
      throw new Error('HTTPS listener missing')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => {})
      let buffer = Buffer.alloc(0)
      let stage: 'greeting' | 'auth' | 'connect' | 'http' = 'greeting'
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          if (stage === 'greeting') {
            if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return
            const method = authenticated ? 2 : 0
            const offered = buffer.subarray(2, 2 + buffer[1]!)
            buffer = buffer.subarray(2 + buffer[1]!)
            if (!offered.includes(method)) {
              socket.end(Buffer.from([5, 255]))
              return
            }
            socket.write(Buffer.from([5, method]))
            stage = authenticated ? 'auth' : 'connect'
          } else if (stage === 'auth') {
            if (buffer.length < 2) return
            const usernameLength = buffer[1]!
            if (buffer.length < 3 + usernameLength) return
            const passwordLength = buffer[2 + usernameLength]!
            if (buffer.length < 3 + usernameLength + passwordLength) return
            const credentials = {
              username: buffer.subarray(2, 2 + usernameLength).toString(),
              password: buffer
                .subarray(3 + usernameLength, 3 + usernameLength + passwordLength)
                .toString(),
            }
            buffer = buffer.subarray(3 + usernameLength + passwordLength)
            authentications.push(credentials)
            if (credentials.username !== username || credentials.password !== password) {
              socket.end(Buffer.from([1, 1]))
              return
            }
            socket.write(Buffer.from([1, 0]))
            stage = 'connect'
          } else if (stage === 'connect') {
            if (buffer.length < 5) return
            const addressLength =
              buffer[3] === 3
                ? buffer[4]!
                : buffer[3] === 1
                  ? 4
                  : buffer[3] === 4
                    ? 16
                    : 0
            const addressOffset = buffer[3] === 3 ? 5 : 4
            const total = addressOffset + addressLength + 2
            if (buffer.length < total) return
            const address = buffer
              .subarray(addressOffset, addressOffset + addressLength)
              .toString()
            const port = buffer.readUInt16BE(total - 2)
            const secureEcho = matching && port === 443
            const allowed =
              buffer[1] === 1 && ((address === hostname && port === 80) || secureEcho)
            buffer = buffer.subarray(total)
            const reply = Buffer.from([5, allowed ? 0 : 5, 0, 1, 127, 0, 0, 1, 0, 80])
            if (!allowed) {
              socket.end(reply)
              return
            }
            socket.write(reply)
            if (secureEcho) {
              socket.removeAllListeners('data')
              const remote = connectSocket(httpsAddress.port, '127.0.0.1')
              sockets.add(remote)
              remote.on('close', () => sockets.delete(remote))
              remote.on('error', () => socket.destroy())
              socket.on('close', () => remote.destroy())
              if (buffer.length) remote.write(buffer)
              socket.pipe(remote)
              remote.pipe(socket)
              return
            }
            stage = 'http'
          } else {
            const end = buffer.indexOf('\r\n\r\n')
            if (end < 0) return
            requests.push(buffer.subarray(0, end).toString())
            socket.end(
              `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
            )
            return
          }
        }
      })
    })
    let child: ChildProcessWithoutNullStreams | undefined
    let exited: Promise<number | null> | undefined
    let stdout = ''
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Listener missing')
      const credentials = authenticated
        ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
        : ''
      const proxy = `socks5://${credentials}127.0.0.1:${address.port}`
      const version = parseBrowserVersion(
        (await promisify(execFile)(binary!, ['--version'])).stdout,
      )
      const userData = join(directory, 'user-data')
      const cache = join(directory, 'cache')
      const preload = join(directory, 'no-database.mjs')
      await writeFile(
        preload,
        `globalThis.fetch = () => Promise.reject(new Error('Database downloads are unavailable on this fresh install'));`,
      )
      child = spawn(
        process.env.NEXUS_TEST_RUNTIME_NODE ?? process.execPath,
        [
          '--import',
          preload,
          process.env.NEXUS_TEST_RUNTIME_RUNNER ??
            fileURLToPath(new URL('../dist/profile-runner.js', import.meta.url)),
          'launch',
          userData,
        ],
        {
          env: {
            ...process.env,
            NODE_PATH: '',
            NODE_OPTIONS: '',
            NODE_EXTRA_CA_CERTS: certificate,
            CLOAKBROWSER_CACHE_DIR: cache,
          },
        },
      )
      child.stdout.on('data', (data: Buffer) => (stdout += data.toString()))
      child.stderr.on('data', (data: Buffer) => (stderr += data.toString()))
      child.stdin.on('error', () => {})
      exited = new Promise((resolve, reject) => {
        child!.once('error', reject)
        child!.once('close', resolve)
      })
      timer = setTimeout(() => child!.kill(), 25_000)
      child.stdin.write(
        JSON.stringify({
          schema_version: 1,
          id: 'synthetic',
          binary_path: binary!,
          binding: { profile_id: 'synthetic', channel_version: version },
          proxy,
          settings: {
            platform: '',
            note: '',
            geoip: matching,
            timezone: manual ? 'America/New_York' : '',
            locale: manual ? 'fr-FR' : '',
            viewport: 'default',
            fingerprintSeed: null,
            startUrl: `http://${hostname}/through-proxy`,
          },
        }) + '\n',
      )
      await expect
        .poll(() => requests, { timeout: 10_000 })
        .toContainEqual(expect.stringContaining('GET /through-proxy HTTP/1.1'))
      expect(stdout).toBe('NEXUS_READY\n')
      expect(stderr).toBe('')
      if (matching) {
        expect(echoes).toBeGreaterThan(0)
        await expect(
          readFile(join(cache, 'geoip/GeoLite2-City.mmdb')),
        ).rejects.toMatchObject({
          code: 'ENOENT',
        })
        const timezone = manual ? 'America%2FNew_York' : 'Europe%2FLondon'
        const locale = manual ? 'fr-FR' : 'en-GB'
        await expect
          .poll(() => requests)
          .toContainEqual(
            expect.stringContaining(`/fingerprint?timezone=${timezone}&locale=${locale}`),
          )
        if (process.platform === 'darwin') {
          const processes = (await promisify(execFile)('ps', ['-axo', 'command'])).stdout
          const command = processes
            .split('\n')
            .find((line) => line.includes(`--user-data-dir=${userData}`))
          expect(command?.includes('--fingerprint-webrtc-ip=81.2.69.160')).toBe(true)
        }
      }
      if (authenticated) {
        expect(authentications).toContainEqual({ username, password })
      } else {
        expect(authentications).toEqual([])
      }
    } finally {
      child?.stdin.end('stop\n')
      let exit: number | null | undefined
      try {
        exit = await exited
      } finally {
        clearTimeout(timer)
        for (const socket of sockets) socket.destroy()
        await Promise.all([
          new Promise<void>((resolve) => server.close(() => resolve())),
          new Promise<void>((resolve) => https.close(() => resolve())),
        ])
        await rm(directory, { recursive: true, force: true })
      }
      if (exited) expect(exit, stderr).toBe(0)
    }
  },
  30_000,
)
