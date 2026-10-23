import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer, type Server } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const servers: Server[] = []

async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No listener')
  return address.port
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

async function fetchFromChild(proxy: string, target: string): Promise<number> {
  const preload = fileURLToPath(new URL('../dist/network-preload.js', import.meta.url))
  const child = spawn(
    process.execPath,
    [
      '--import',
      preload,
      '-e',
      `fetch(${JSON.stringify(target)}).then(async r => {
        if (!r.ok || await r.text() !== 'through proxy') process.exitCode = 2
      }).catch(() => { process.exitCode = 1 })`,
    ],
    { env: { ...process.env, NEXUS_NETWORK_PROXY: proxy } },
  )
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? -1))
  })
}

describe('application SOCKS5 proxy', () => {
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
            const remote = connect(origin, '127.0.0.1', () => {
              client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
              client.pipe(remote)
              remote.pipe(client)
            })
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
