import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const url = 'http://127.0.0.1:1422/'

export function servesDesktopV2(html) {
  return /<script\b[^>]*\bsrc=["']\/src\/main\.ts(?:\?[^"']*)?["'][^>]*>/i.test(html)
}

async function ensureViteServer() {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
    const html = await response.text()

    if (!response.ok || !servesDesktopV2(html)) {
      throw new Error(`Port 1422 is serving a different application: ${url}`)
    }

    console.log('Using the existing desktop-v2 Vite server on port 1422')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Port 1422')) {
      throw error
    }

    const child = spawn('pnpm', ['exec', 'vite'], { stdio: 'inherit' })

    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => child.kill(signal))
    }

    child.on('error', (spawnError) => {
      console.error(`Could not start the desktop-v2 Vite server: ${spawnError.message}`)
      process.exitCode = 1
    })

    child.on('exit', (code) => {
      process.exitCode = code ?? 1
    })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await ensureViteServer()
}
