import { realpathSync } from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { SalesAgentService } from './capability.js'
import { AgentFailure } from './errors.js'
import { createAgentServer } from './rpc/server.js'
import { createSettingsStore, type SettingsStore } from './store/settings.js'

export interface SalesAgentOptions {
  storageDirectory?: string | null
  store?: SettingsStore
  input?: Readable
  output?: Writable
}

export function createSalesAgentPlugin(options: SalesAgentOptions = {}) {
  if (!options.store && !options.storageDirectory)
    throw new AgentFailure('STORAGE_ERROR', 'ecom agent 需要受管持久化目录')
  const store = options.store ?? createSettingsStore(options.storageDirectory!)
  const service = new SalesAgentService(store)
  const server = createAgentServer({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    dispatch: (context, host) => service.call(context, host),
    status: () => ({ storageDurable: store.durable === true }),
    scrub: (message) => service.scrub(message),
    onFatal: () => {
      process.exitCode = 1
      if (options.input === undefined) process.exit(1)
    },
  })
  return { store, service, server, stop: () => server.stop() }
}

export function startSalesAgentPlugin(options: SalesAgentOptions = {}) {
  const instance = createSalesAgentPlugin(options)
  instance.server.start()
  return instance
}

function invokedDirectly(): boolean {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const instance = startSalesAgentPlugin({
    storageDirectory: process.env['NEXUS_PLUGIN_STORAGE_DIR'] ?? null,
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      instance.stop()
      process.exit(0)
    })
}
