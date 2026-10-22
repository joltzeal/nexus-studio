import { Readable, Writable } from 'node:stream'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { PluginManifest } from '@nexus/plugin-sdk'

import manifest from '../nexus.plugin.js'
import { VINTED_METHODS, VintedMonitor } from './capabilities/vinted-monitor.js'
import { createPluginServer, type PluginServer } from './rpc/server.js'
import { Redactor, createLogger, type Logger } from './rpc/redact.js'
import {
  createFileStore,
  createMemoryStore,
  type PrivateStore,
} from './store/private-store.js'
import { VintedClient } from './services/vinted.js'

export { manifest }
export {
  MAX_ITEMS,
  MAX_MONITORS,
  MAX_RUNS,
  VINTED_METHODS,
  VintedMonitor,
} from './capabilities/vinted-monitor.js'
export { createPluginServer } from './rpc/server.js'
export { createFileStore, createMemoryStore } from './store/private-store.js'
export { VintedClient, USER_AGENT } from './services/vinted.js'
export { PAGE_PAUSE_MS, collect, describeFailure } from './services/collector.js'
export {
  VINTED_DOMAINS,
  catalogueRequest,
  itemPageUrl,
  itemRequestUrl,
  normalizeMonitorUrl,
  wardrobeRequest,
} from './domain/urls.js'
export { parseItemsPage } from './domain/items.js'
export type { DraftItem, ItemsPage } from './domain/items.js'
export type { ItemRecord, MonitorRecord, RunRecord, RunStatus } from './domain/types.js'
export type { MonitorTarget } from './domain/urls.js'
export type { PluginManifest }

export interface VintedMonitorPluginOptions {
  /** Private directory owned by the host; omitted means a non-durable memory store. */
  storageDirectory?: string | null
  input?: Readable
  output?: Writable
  diagnostics?: Writable
  fetchImpl?: typeof fetch
  now?: () => Date
  idFactory?: () => string
  client?: VintedClient
  /** Test hook: replaces the politeness delay between pages. */
  pause?: (milliseconds: number) => Promise<void>
}

export interface VintedMonitorPluginInstance {
  readonly server: PluginServer
  readonly plugin: VintedMonitor
  readonly store: PrivateStore
  readonly logger: Logger
  readonly redactor: Redactor
  /** Stops the scheduler and the RPC loop. */
  stop(): void
}

/** How often the scheduler looks for monitors whose interval has elapsed. */
export const TICK_INTERVAL_MS = 60_000

/** Wires the capability, storage and protocol together. */
export function createVintedMonitorPlugin(
  options: VintedMonitorPluginOptions = {},
): VintedMonitorPluginInstance {
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
    new VintedClient(
      options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
    )

  const plugin = new VintedMonitor({
    store,
    logger,
    client,
    now,
    ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
    ...(options.pause === undefined ? {} : { pause: options.pause }),
  })

  let stop: () => void = () => undefined
  const server = createPluginServer({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    manifest,
    methods: VINTED_METHODS,
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
export function startVintedMonitorPlugin(
  options: VintedMonitorPluginOptions = {},
): VintedMonitorPluginInstance {
  const instance = createVintedMonitorPlugin(options)
  instance.server.start()
  // `unref` keeps the process able to exit when the host closes the pipes.
  const timer = setInterval(() => {
    void instance.plugin.tick()
  }, TICK_INTERVAL_MS)
  timer.unref()
  return {
    ...instance,
    stop: () => {
      clearInterval(timer)
      instance.stop()
    },
  }
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
  const instance = startVintedMonitorPlugin({
    // Injected by the host, not by a user .env file.
    storageDirectory: process.env['NEXUS_PLUGIN_STORAGE_DIR'] ?? null,
  })
  if (instance.store.durable === false) {
    instance.logger.warn('宿主未提供 NEXUS_PLUGIN_STORAGE_DIR，本次运行的监控不会持久化')
  }
}
