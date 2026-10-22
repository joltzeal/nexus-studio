import { once } from 'node:events'
import { frameLines } from './framing.js'
import { handleLine, protocolError } from './protocol.js'

async function main(): Promise<void> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  for await (const frame of frameLines(process.stdin)) {
    let response
    if (frame.kind === 'oversized') {
      response = protocolError(-32600, 'Request exceeds 65536 byte line limit')
    } else {
      try {
        response = handleLine(decoder.decode(frame.bytes), process.versions.node)
      } catch {
        response = protocolError(-32700, 'Parse error')
      }
    }
    if (response !== undefined) {
      if (!process.stdout.write(`${JSON.stringify(response)}\n`)) {
        await once(process.stdout, 'drain')
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(
    'Runtime stdio failure:',
    error instanceof Error ? error.message : 'unknown error',
  )
  process.exitCode = 1
})
