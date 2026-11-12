import { realpathSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import manifest from '../nexus.plugin.js'
import { EMAIL_METHODS, EmailService } from './capabilities/email.js'
import { EmailProviders } from './providers/factory.js'
import { MicrosoftEmailFactory } from './providers/microsoft.js'
import { createPluginServer } from './rpc/server.js'
import { createLogger, Redactor } from './rpc/redact.js'
import { createFileStore, createMemoryStore } from './store/private-store.js'
import type { ProviderRegistry } from './services/refresh.js'

export { manifest, EMAIL_METHODS, EmailService, EmailProviders, MicrosoftEmailFactory }
export { EmailProviderFactory } from './domain/types.js'
export type {
  EmailProvider,
  TokenRefresher,
  MailboxClient,
  MailboxView,
  MailMessage,
  MailMessageDetail,
  MailTransport,
} from './domain/types.js'
export { createFileStore, createMemoryStore } from './store/private-store.js'

export interface EmailPluginOptions {
  storageDirectory?: string | null
  input?: Readable
  output?: Writable
  diagnostics?: Writable
  now?: () => Date
  providers?: ProviderRegistry
  fetchImpl?: typeof fetch
}

export function createEmailPlugin(options: EmailPluginOptions = {}) {
  const now = options.now ?? (() => new Date())
  const logger = createLogger(
    (line) => (options.diagnostics ?? process.stderr).write(line),
    new Redactor(),
    now,
  )
  const store = options.storageDirectory
    ? createFileStore(options.storageDirectory)
    : createMemoryStore()
  const providers =
    options.providers ??
    new EmailProviders([
      new MicrosoftEmailFactory(
        options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
      ),
    ])
  const plugin = new EmailService({ store, providers, logger, now })
  const input = options.input ?? process.stdin
  let stop = (): Promise<void> => Promise.resolve()
  const server = createPluginServer({
    input,
    output: options.output ?? process.stdout,
    manifest,
    methods: EMAIL_METHODS,
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

export function startEmailPlugin(options: EmailPluginOptions = {}) {
  const instance = createEmailPlugin(options)
  instance.server.start()
  instance.plugin.start()
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
  const instance = startEmailPlugin({
    storageDirectory: process.env['NEXUS_PLUGIN_STORAGE_DIR'] ?? null,
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => void instance.stop().finally(() => process.exit(0)))
}
