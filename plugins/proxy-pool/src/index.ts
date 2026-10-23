import { Readable, Writable } from 'node:stream'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { PluginManifest } from '@nexus/plugin-sdk'

import manifest from '../nexus.plugin.js'
import { PROXY_METHODS, ProxyPool } from './capabilities/proxy-provider.js'
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
import {
  httpGetViaProxy,
  type HttpResponse,
  type ProxyTarget,
} from './services/proxy-transport.js'
import { createMemoryCache, lookupIpReputation } from './services/reputation.js'

export { manifest }
export { PROXY_METHODS, ProxyPool } from './capabilities/proxy-provider.js'
export { createPluginServer } from './rpc/server.js'
export { createFileStore, createMemoryStore } from './store/private-store.js'
export { createFileVault, createMemoryVault } from './store/secret-vault.js'
export {
  ProxyTransferDataSchema,
  TransferExportInputSchema,
  TransferImportInputSchema,
  TransferReceiptInputSchema,
} from './domain/transfer.js'
export type {
  ProxyTransferData,
  ProxyTransferExportInput,
  ProxyTransferImportInput,
  ProxyTransferImportResult,
  ProxyTransferReceiptInput,
} from './domain/transfer.js'
export type { PluginManifest }

export interface ProxyPluginOptions {
  /** Private directory owned by the host; omitted means a non-durable memory store. */
  storageDirectory?: string | null
  input?: Readable
  output?: Writable
  diagnostics?: Writable
  transport?: (
    target: ProxyTarget,
    url: URL,
    options: { timeoutMs: number },
  ) => Promise<HttpResponse>
  fetchImpl?: typeof fetch
  now?: () => Date
}

export interface ProxyPluginInstance {
  readonly server: PluginServer
  readonly plugin: ProxyPool
  readonly store: PrivateStore
  readonly vault: SecretVault
  readonly logger: Logger
  readonly redactor: Redactor
}

/**
 * Wires the capability, storage, vault and protocol together. Exported so tests
 * and a host can drive the same instance without spawning a process.
 */
export function createProxyPlugin(options: ProxyPluginOptions = {}): ProxyPluginInstance {
  const now = options.now ?? (() => new Date())
  const redactor = new Redactor()
  const logger = createLogger(
    (line) => (options.diagnostics ?? process.stderr).write(line),
    redactor,
    now,
  )
  const directory = options.storageDirectory ?? null
  const store = directory === null ? createMemoryStore() : createFileStore(directory)
  // Passwords sit next to the inventory in the plugin's own directory, in
  // plaintext. Host-private launch/transfer RPCs can materialize them.
  const vault =
    directory === null
      ? createMemoryVault(redactor)
      : createFileVault(directory, redactor)
  const cache = createMemoryCache()

  const reputation = async (ip: string) => {
    const document = await store.read()
    const apiKeyRef = document.config.risk.apiKeyRef
    let apiKey: string | null = null
    if (apiKeyRef !== null) {
      try {
        apiKey = await vault.resolve(apiKeyRef)
      } catch {
        // A missing key degrades to an unauthenticated lookup, never to a crash.
        apiKey = null
      }
    }
    return lookupIpReputation(ip, {
      apiKey,
      enabled: document.config.risk.enabled,
      cacheSeconds: document.config.risk.cacheSeconds,
      now,
      cache,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    })
  }

  const plugin = new ProxyPool({
    store,
    vault,
    logger,
    now,
    check: {
      transport: options.transport ?? httpGetViaProxy,
      reputation,
      now,
    },
  })

  let stop: () => void = () => undefined
  const server = createPluginServer({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    manifest,
    methods: PROXY_METHODS,
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

  return { server, plugin, store, vault, logger, redactor }
}

/** Process entry: starts the RPC loop on the host-provided streams. */
export function startProxyPlugin(options: ProxyPluginOptions = {}): ProxyPluginInstance {
  const instance = createProxyPlugin(options)
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
  const instance = startProxyPlugin({
    // Injected by the host, not by a user .env file.
    storageDirectory: process.env['NEXUS_PLUGIN_STORAGE_DIR'] ?? null,
  })
  if (instance.store.durable === false) {
    instance.logger.warn(
      '宿主未提供 NEXUS_PLUGIN_STORAGE_DIR，本次运行的代理库存与订阅不会持久化',
    )
  }
  if (instance.vault.durable === false) {
    instance.logger.warn('宿主未提供私有目录，本次运行的代理密码不会持久化')
  }
}
