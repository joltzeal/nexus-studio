import { Readable, Writable } from 'node:stream'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { PluginManifest } from '@nexus/plugin-sdk'

import manifest from '../nexus.plugin.js'
import { SUPPLY_METHODS, SharedSupply } from './capabilities/shared-supply.js'
import { createPluginServer, type PluginServer } from './rpc/server.js'
import { Redactor, createLogger, type Logger } from './rpc/redact.js'
import {
  createFileStore,
  createMemoryStore,
  type PrivateStore,
} from './store/private-store.js'
import { SharedSupplyClient } from './services/upstream.js'
import { SharedSupplyImages } from './services/images.js'

export { manifest }
export {
  MAX_FAVORITES,
  SUPPLY_METHODS,
  SharedSupply,
} from './capabilities/shared-supply.js'
export { createPluginServer } from './rpc/server.js'
export { createFileStore, createMemoryStore } from './store/private-store.js'
export {
  CATEGORIES,
  CATEGORY_IDS,
  SharedSupplyClient,
  decodeBody,
  encodeBody,
} from './services/upstream.js'
export {
  favoritesCsv,
  imageUrls,
  merchantRecord,
  productRecord,
  publishedAt,
} from './domain/product.js'
export type { FavoriteRecord, MerchantRecord, ProductRecord } from './domain/product.js'
export type { PluginManifest }

export interface SharedSupplyPluginOptions {
  /** Private directory owned by the host; omitted means a non-durable memory store. */
  storageDirectory?: string | null
  input?: Readable
  output?: Writable
  diagnostics?: Writable
  fetchImpl?: typeof fetch
  now?: () => Date
  idFactory?: () => string
  client?: SharedSupplyClient
}

export interface SharedSupplyPluginInstance {
  readonly server: PluginServer
  readonly plugin: SharedSupply
  readonly store: PrivateStore
  readonly logger: Logger
  readonly redactor: Redactor
}

/** Wires the capability, storage and protocol together. */
export function createSharedSupplyPlugin(
  options: SharedSupplyPluginOptions = {},
): SharedSupplyPluginInstance {
  const now = options.now ?? (() => new Date())
  const redactor = new Redactor()
  const logger = createLogger(
    (line) => (options.diagnostics ?? process.stderr).write(line),
    redactor,
    now,
  )
  const directory = options.storageDirectory ?? null
  const store = directory === null ? createMemoryStore() : createFileStore(directory)
  const client =
    options.client ??
    new SharedSupplyClient(
      options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
    )

  const plugin = new SharedSupply({
    client,
    images: new SharedSupplyImages(
      options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
    ),
    store,
    logger,
    now,
    ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
  })

  let stop: () => void = () => undefined
  const server = createPluginServer({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    manifest,
    methods: SUPPLY_METHODS,
    dispatch: (context) => plugin.call(context),
    logger,
    status: () => ({ ...plugin.status(), pid: process.pid }),
    onFatal: () => {
      // Repeated protocol violations: let the host recycle the process.
      process.exitCode = 1
      stop()
      if (options.input === undefined) process.exit(1)
    },
  })
  stop = () => server.stop()

  return { server, plugin, store, logger, redactor }
}

/** Process entry: starts the RPC loop on the host-provided streams. */
export function startSharedSupplyPlugin(
  options: SharedSupplyPluginOptions = {},
): SharedSupplyPluginInstance {
  const instance = createSharedSupplyPlugin(options)
  instance.server.start()
  return instance
}

/**
 * Node resolves `import.meta.url` to the real path but leaves `argv[1]` as
 * given, so a data directory under `/var` or `/tmp` would otherwise look like a
 * different file and the entry point would exit silently without a handshake.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const instance = startSharedSupplyPlugin({
    // Injected by the host, not by a user .env file.
    storageDirectory: process.env['NEXUS_PLUGIN_STORAGE_DIR'] ?? null,
  })
  if (instance.store.durable === false) {
    instance.logger.warn('宿主未提供 NEXUS_PLUGIN_STORAGE_DIR，本次运行的收藏不会持久化')
  }
}
