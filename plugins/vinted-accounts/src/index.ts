import { realpathSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import type { PluginManifest } from '@nexus/plugin-sdk'

import manifest from '../nexus.plugin.js'
import { ACCOUNT_METHODS, AccountPool } from './capabilities/accounts.js'
import { createPluginServer, type PluginServer } from './rpc/server.js'
import { Redactor, createLogger, type Logger } from './rpc/redact.js'
import {
  createFileStore,
  createMemoryStore,
  type AccountStore,
} from './store/account-store.js'

export { manifest }
export {
  ACCOUNT_METHODS,
  MAX_ACCOUNTS,
  MAX_IMPORT_ERRORS,
  AccountPool,
} from './capabilities/accounts.js'
export type { AccountBindingView } from './capabilities/accounts.js'
export { createPluginServer } from './rpc/server.js'
export { createFileStore, createMemoryStore } from './store/account-store.js'
export { parseCsv, parseXlsx, buildXlsx, serializeCsv } from './domain/table.js'
export {
  TEMPLATE_HEADERS,
  mapHeaders,
  normalizeHomepage,
  parseAccountRows,
} from './domain/import.js'
export type { AccountField, ParseOutcome, ParsedAccount } from './domain/import.js'
export type {
  AccountInput,
  AccountRecord,
  AccountStatus,
  BindingRecord,
  ImportReport,
  LoginMethod,
  TemplateFile,
} from './domain/types.js'
export {
  AccountTransferDataSchema,
  TransferExportInputSchema,
  TransferImportInputSchema,
  TransferReceiptInputSchema,
} from './domain/transfer.js'
export type {
  AccountTransferData,
  AccountTransferExportInput,
  AccountTransferImportInput,
  AccountTransferImportResult,
  AccountTransferReceiptInput,
} from './domain/transfer.js'
export type { PluginManifest }

export interface VintedAccountsPluginOptions {
  /** Private directory owned by the host; omitted means a non-durable memory store. */
  storageDirectory?: string | null
  input?: Readable
  output?: Writable
  diagnostics?: Writable
  now?: () => Date
  idFactory?: () => string
  /** Overrides `globalThis.fetch`; used by tests to answer an inbox link. */
  fetchImpl?: typeof fetch
}

export interface VintedAccountsPluginInstance {
  readonly server: PluginServer
  readonly plugin: AccountPool
  readonly store: AccountStore
  readonly logger: Logger
  readonly redactor: Redactor
  stop(): void
}

/** Wires the capability, storage and protocol together. */
export function createVintedAccountsPlugin(
  options: VintedAccountsPluginOptions = {},
): VintedAccountsPluginInstance {
  const now = options.now ?? (() => new Date())
  const redactor = new Redactor()
  const logger = createLogger(
    (line) => (options.diagnostics ?? process.stderr).write(line),
    redactor,
    now,
  )
  const directory = options.storageDirectory ?? null
  const store = directory === null ? createMemoryStore() : createFileStore(directory)

  const plugin = new AccountPool({
    store,
    logger,
    now,
    ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })

  let stop: () => void = () => undefined
  const server = createPluginServer({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    manifest,
    methods: ACCOUNT_METHODS,
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
    logger,
    redactor,
    stop: () => {
      server.stop()
    },
  }
}

/** Process entry: starts the RPC loop on the host-provided streams. */
export function startVintedAccountsPlugin(
  options: VintedAccountsPluginOptions = {},
): VintedAccountsPluginInstance {
  const instance = createVintedAccountsPlugin(options)
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
  const instance = startVintedAccountsPlugin({
    // Injected by the host, not by a user .env file.
    storageDirectory: process.env['NEXUS_PLUGIN_STORAGE_DIR'] ?? null,
  })
  if (instance.store.durable === false) {
    instance.logger.warn('宿主未提供 NEXUS_PLUGIN_STORAGE_DIR，本次运行的账号不会持久化')
  }
}
