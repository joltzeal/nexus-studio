import { spawn } from 'node:child_process'

const url = 'http://localhost:1420/'

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
  const html = await response.text()
  if (!response.ok || !html.includes('Nexus Studio')) {
    throw new Error(`Port 1420 serves a different application: ${url}`)
  }
  console.log('Using the existing Nexus Vite server on port 1420')
} catch (error) {
  if (error instanceof Error && error.message.startsWith('Port 1420')) throw error
  const child = spawn('pnpm', ['dev'], { stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal))
  }
  child.on('exit', (code) => {
    process.exitCode = code ?? 1
  })
}
