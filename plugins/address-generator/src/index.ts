import { Readable, Writable } from 'node:stream'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { PluginManifest } from '@nexus/plugin-sdk'

import manifest from '../nexus.plugin.js'
import { ADDRESS_METHODS, AddressGenerator } from './capabilities/address-generator.js'
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
import { PublicAddressService } from './services/overpass.js'

export { manifest }
export { ADDRESS_METHODS, AddressGenerator } from './capabilities/address-generator.js'
export { createPluginServer } from './rpc/server.js'
export { createFileStore, createMemoryStore } from './store/private-store.js'
export { createFileVault, createMemoryVault } from './store/secret-vault.js'
export {
  PublicAddressService,
  cleanElements,
  sampleAddresses,
} from './services/overpass.js'
export { CITIES, COUNTRIES, findCity } from './services/catalog.js'
export { buildProfiles } from './services/profiles.js'
export { asciiName, generateUsername, numberSuffix } from './services/username.js'
export { addressKey, addressText, profileText, profilesCsv } from './domain/address.js'
export type { AddressRecord, ProfileRecord } from './domain/address.js'
export type { PluginManifest }

export interface AddressPluginOptions {
  /** Private directory owned by the host; omitted means a non-durable memory store. */
  storageDirectory?: string | null
  input?: Readable
  output?: Writable
  diagnostics?: Writable
  fetchImpl?: typeof fetch
  now?: () => Date
  random?: () => number
  lookup?: PublicAddressService
}

export interface AddressPluginInstance {
  readonly server: PluginServer
  readonly plugin: AddressGenerator
  readonly store: PrivateStore
  readonly vault: SecretVault
  readonly logger: Logger
  readonly redactor: Redactor
}

/** Wires the capability, storage, vault and protocol together. */
export function createAddressPlugin(
  options: AddressPluginOptions = {},
): AddressPluginInstance {
  const now = options.now ?? (() => new Date())
  const redactor = new Redactor()
  const logger = createLogger(
    (line) => (options.diagnostics ?? process.stderr).write(line),
    redactor,
    now,
  )
  const directory = options.storageDirectory ?? null
  const store = directory === null ? createMemoryStore() : createFileStore(directory)
  // The map key sits next to the plugin document in plaintext, in the plugin's
  // own directory. The host never stores it and there is no system keychain.
  const vault =
    directory === null
      ? createMemoryVault(redactor)
      : createFileVault(directory, redactor)
  const lookup =
    options.lookup ??
    new PublicAddressService({
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    })

  const plugin = new AddressGenerator({
    store,
    vault,
    lookup,
    logger,
    now,
    ...(options.random === undefined ? {} : { random: options.random }),
  })

  let stop: () => void = () => undefined
  const server = createPluginServer({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    manifest,
    methods: ADDRESS_METHODS,
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
export function startAddressPlugin(
  options: AddressPluginOptions = {},
): AddressPluginInstance {
  const instance = createAddressPlugin(options)
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
  const instance = startAddressPlugin({
    // Injected by the host, not by a user .env file.
    storageDirectory: process.env['NEXUS_PLUGIN_STORAGE_DIR'] ?? null,
  })
  if (instance.store.durable === false) {
    instance.logger.warn(
      '宿主未提供 NEXUS_PLUGIN_STORAGE_DIR，本次运行的地图 Key 不会持久化',
    )
  }
}
