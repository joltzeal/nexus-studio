import { realpathSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import type { PluginManifest } from '@nexus/plugin-sdk'

import manifest from '../nexus.plugin.js'
import { SIM8_METHODS, Sim8Provider } from './capabilities/sim8.js'
import { createPluginServer, type PluginServer } from './rpc/server.js'
import { Redactor, createLogger, type Logger } from './rpc/redact.js'
import {
  createFileStore,
  createMemoryStore,
  type PrivateStore,
} from './store/private-store.js'
import {
  createFileVault,
  createMemoryVault,
  type SecretVault,
} from './store/secret-vault.js'

export { manifest }
export { SIM8_METHODS, Sim8Provider } from './capabilities/sim8.js'
export { createPluginServer } from './rpc/server.js'
export { createFileStore, createMemoryStore } from './store/private-store.js'
export { createFileVault, createMemoryVault } from './store/secret-vault.js'
export { extractOtp } from './domain/otp.js'
export {
  mergeRecords,
  findRecord,
  removeRecord,
  searchRecords,
  recordKey,
  MAX_RECORDS,
} from './domain/records.js'
export {
  normalizeBaseUrl,
  normalizeToken,
  Sim8Client,
  DEFAULT_BASE_URL,
} from './services/client.js'
export type { StoreDocument, StoreConfig, PrivateStore } from './store/private-store.js'
export type { SecretVault } from './store/secret-vault.js'
export type {
  AllocationState,
  AppItem,
  AppType,
  CategoryItem,
  FilterAppItem,
  FilterDetail,
  OrderItem,
  PrefixItem,
  PrefixReport,
  ProfileInfo,
  PurchasedApi,
  RenewReport,
  SmsRead,
  SmsRecord,
} from './domain/types.js'
export type { PluginManifest }

export interface Sim8PluginOptions {
  /** Private directory owned by the host; omitted means a non-durable memory store. */
  storageDirectory?: string | null
  input?: Readable
  output?: Writable
  diagnostics?: Writable
  now?: () => Date
  /** Overrides `globalThis.fetch`; used by tests to answer the API and record links. */
  fetchImpl?: typeof fetch
  requestIdFactory?: () => string
}

export interface Sim8PluginInstance {
  readonly server: PluginServer
  readonly plugin: Sim8Provider
  readonly store: PrivateStore
  readonly vault: SecretVault
  readonly logger: Logger
  readonly redactor: Redactor
  stop(): void
}

/** Wires the capability, storage and protocol together. */
export function createSim8Plugin(options: Sim8PluginOptions = {}): Sim8PluginInstance {
  const now = options.now ?? (() => new Date())
  const redactor = new Redactor()
  const logger = createLogger(
    (line) => (options.diagnostics ?? process.stderr).write(line),
    redactor,
    now,
  )
  const directory = options.storageDirectory ?? null
  const store = directory === null ? createMemoryStore() : createFileStore(directory)
  const vault =
    directory === null
      ? createMemoryVault(redactor)
      : createFileVault(directory, redactor)

  const plugin = new Sim8Provider({
    store,
    vault,
    logger,
    now,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.requestIdFactory === undefined
      ? {}
      : { requestIdFactory: options.requestIdFactory }),
  })

  let stop: () => void = () => undefined
  const server = createPluginServer({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    manifest,
    methods: SIM8_METHODS,
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

  return {
    server,
    plugin,
    store,
    vault,
    logger,
    redactor,
    stop: () => {
      server.stop()
    },
  }
}

/** Process entry: starts the RPC loop on the host-provided streams. */
export function startSim8Plugin(options: Sim8PluginOptions = {}): Sim8PluginInstance {
  const instance = createSim8Plugin(options)
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
  const instance = startSim8Plugin({
    // Injected by the host, not by a user .env file.
    storageDirectory: process.env['NEXUS_PLUGIN_STORAGE_DIR'] ?? null,
  })
  if (instance.store.durable === false) {
    instance.logger.warn('宿主未提供 NEXUS_PLUGIN_STORAGE_DIR，本次运行的号码不会持久化')
  }
}
