import { realpathSync } from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import manifest from '../nexus.plugin.js'
import { ProductsService } from './capabilities/products.js'
import { PRODUCT_METHODS } from './contracts.js'
import { createLogger, Redactor } from './rpc/redact.js'
import { createPluginServer } from './rpc/server.js'
import {
  createFileStore,
  createMemoryStore,
  type ProductsStore,
} from './store/private-store.js'

export { manifest, PRODUCT_METHODS, ProductsService, createFileStore, createMemoryStore }
export type { ProductsStore, StoreDocument } from './store/private-store.js'
export type { DispatchContext } from './rpc/protocol.js'

export interface ProductsPluginOptions {
  storageDirectory?: string | null
  store?: ProductsStore
  input?: Readable
  output?: Writable
  diagnostics?: Writable
  now?: () => Date
}

export function createProductsPlugin(options: ProductsPluginOptions = {}) {
  const now = options.now ?? (() => new Date())
  const logger = createLogger(
    (line) => (options.diagnostics ?? process.stderr).write(line),
    new Redactor(),
    now,
  )
  const store =
    options.store ??
    (options.storageDirectory
      ? createFileStore(options.storageDirectory)
      : createMemoryStore())
  const plugin = new ProductsService({ store, now })
  const input = options.input ?? process.stdin
  let stop = (): Promise<void> => Promise.resolve()
  const server = createPluginServer({
    input,
    output: options.output ?? process.stdout,
    manifest,
    methods: PRODUCT_METHODS,
    dispatch: (context) => plugin.call(context),
    logger,
    status: () => ({ ...plugin.status(), pid: process.pid }),
    onFatal: () => {
      process.exitCode = 1
      void stop()
      if (options.input === undefined) process.exit(1)
    },
  })
  stop = () => {
    server.stop()
    return plugin.stop()
  }
  input.once('end', () => void stop())
  input.once('error', () => void stop())
  return { plugin, store, server, stop }
}

export function startProductsPlugin(options: ProductsPluginOptions = {}) {
  const instance = createProductsPlugin(options)
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
  const instance = startProductsPlugin({
    storageDirectory: process.env['NEXUS_PLUGIN_STORAGE_DIR'] ?? null,
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => void instance.stop().finally(() => process.exit(0)))
}
