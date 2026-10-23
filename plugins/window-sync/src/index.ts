import { realpathSync } from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import manifest from '../nexus.plugin.js'
import { createPluginServer } from './rpc/server.js'
import { WindowSync } from './transport.js'

export { manifest, WindowSync }
export { SYNC_METHODS } from './types.js'
export type { Invitation, OfferResult, SyncStatus } from './types.js'
export type { WindowSyncOptions } from './transport.js'

export function createWindowSyncPlugin(
  options: {
    input?: Readable
    output?: Writable
    diagnostics?: Writable
    transport?: WindowSync
  } = {},
) {
  const transport = options.transport ?? new WindowSync()
  const server = createPluginServer({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    diagnostics: options.diagnostics ?? process.stderr,
    transport,
  })
  return { server, transport }
}

function invokedDirectly(): boolean {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    )
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const instance = createWindowSyncPlugin()
  const shutdown = (): void => {
    void instance.server.stop().finally(() => {
      process.stdin.destroy()
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  instance.server.start()
}
