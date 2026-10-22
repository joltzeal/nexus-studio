import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { frameLines } from './framing.js'
import type { RuntimeHealth } from './protocol.js'

const HEALTHCHECK_ID = 'runtime-healthcheck'
const TIMEOUT_MS = 5_000

function isHealthResponse(input: unknown): input is { result: RuntimeHealth } {
  if (typeof input !== 'object' || input === null) return false
  const response = input as Record<string, unknown>
  const result = response.result
  if (typeof result !== 'object' || result === null || 'error' in response) return false
  const health = result as Record<string, unknown>
  return (
    response.jsonrpc === '2.0' &&
    response.id === HEALTHCHECK_ID &&
    health.status === 'ok' &&
    health.protocolVersion === 1 &&
    health.runtime === 'node' &&
    health.nodeVersion === process.versions.node &&
    health.browser === 'not-connected'
  )
}

async function checkHealth(): Promise<RuntimeHealth> {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./main.js', import.meta.url))],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  child.stderr.pipe(process.stderr)
  const closed = once(child, 'close')
  child.stdin.on('error', () => {
    // Early child exit is reported by the response/exit checks below.
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)

  try {
    child.stdin.end(
      `${JSON.stringify({ jsonrpc: '2.0', id: HEALTHCHECK_ID, method: 'runtime.health' })}\n`,
    )
    let health: RuntimeHealth | undefined
    for await (const frame of frameLines(child.stdout)) {
      if (frame.kind !== 'line' || health !== undefined) {
        throw new Error('Runtime returned an oversized or extra response')
      }
      const response: unknown = JSON.parse(frame.bytes.toString('utf8'))
      if (!isHealthResponse(response))
        throw new Error('Runtime returned invalid health data')
      health = response.result
    }
    const [code, signal] = await closed
    if (code !== 0 || signal !== null)
      throw new Error('Runtime failed or healthcheck timed out')
    if (health === undefined) throw new Error('Runtime exited without a health response')
    return health
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    // Observe a possible spawn failure even when response processing failed first.
    await closed.catch(() => undefined)
  }
}

void checkHealth().then(
  (health) => console.log(JSON.stringify(health)),
  (error: unknown) => {
    console.error(
      'Runtime healthcheck failed:',
      error instanceof Error ? error.message : 'unknown error',
    )
    process.exitCode = 1
  },
)
