import { Readable, Writable } from 'node:stream'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { PluginManifest } from '@nexus/plugin-sdk'

import manifest from '../nexus.plugin.js'
import { AI_IMAGE_METHODS, AiImage } from './capabilities/ai-image.js'
import { createPluginServer, type PluginServer } from './rpc/server.js'
import { Redactor, createLogger, type Logger } from './rpc/redact.js'
import {
  createFileStore,
  createMemoryStore,
  type PrivateStore,
} from './store/private-store.js'
import {
  createFileImageStore,
  createMemoryImageStore,
  type ImageStore,
} from './store/image-files.js'

export { manifest }
export { AI_IMAGE_METHODS, AiImage } from './capabilities/ai-image.js'
export { createPluginServer } from './rpc/server.js'
export { createFileStore, createMemoryStore } from './store/private-store.js'
export { createFileImageStore, createMemoryImageStore } from './store/image-files.js'
export {
  SCENE_PRESETS,
  composePrompt,
  presetById,
  presetLabel,
} from './domain/presets.js'
export { apiKeyHint, extensionFor, providerView } from './domain/types.js'
export type {
  GenerationRecord,
  ProviderRecord,
  ProviderView,
  StoredFile,
  VisionRecord,
  OutputVisionRecord,
} from './domain/types.js'
export type { PluginManifest }

export interface AiImagePluginOptions {
  /** Private directory owned by the host; omitted means a non-durable memory store. */
  storageDirectory?: string | null
  input?: Readable
  output?: Writable
  diagnostics?: Writable
  now?: () => Date
  idFactory?: () => string
  store?: PrivateStore
  images?: ImageStore
  /** Overrides `globalThis.fetch`; used by tests to answer a remote image. */
  fetchImpl?: typeof fetch
}

export interface AiImagePluginInstance {
  readonly server: PluginServer
  readonly plugin: AiImage
  readonly store: PrivateStore
  readonly images: ImageStore
  readonly logger: Logger
  readonly redactor: Redactor
}

/** Wires the capability, storage and protocol together. */
export function createAiImagePlugin(
  options: AiImagePluginOptions = {},
): AiImagePluginInstance {
  const now = options.now ?? (() => new Date())
  const redactor = new Redactor()
  const logger = createLogger(
    (line) => (options.diagnostics ?? process.stderr).write(line),
    redactor,
    now,
  )
  const directory = options.storageDirectory ?? null
  const store =
    options.store ??
    (directory === null ? createMemoryStore() : createFileStore(directory))
  const images =
    options.images ??
    (directory === null
      ? createMemoryImageStore()
      : createFileImageStore(join(directory, 'images'), join(directory, 'exports')))

  const plugin = new AiImage({
    store,
    images,
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
    methods: AI_IMAGE_METHODS,
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

  return { server, plugin, store, images, logger, redactor }
}

/** Process entry: starts the RPC loop on the host-provided streams. */
export function startAiImagePlugin(
  options: AiImagePluginOptions = {},
): AiImagePluginInstance {
  const instance = createAiImagePlugin(options)
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
  const instance = startAiImagePlugin({
    // Injected by the host, not by a user .env file.
    storageDirectory: process.env['NEXUS_PLUGIN_STORAGE_DIR'] ?? null,
  })
  if (instance.store.durable === false) {
    instance.logger.warn(
      '宿主未提供 NEXUS_PLUGIN_STORAGE_DIR，本次运行的配置与记录不会持久化',
    )
  }
}
