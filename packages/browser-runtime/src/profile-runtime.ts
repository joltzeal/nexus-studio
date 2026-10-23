import { ensureBinary, launchPersistentContext, validateLicense } from 'cloakbrowser'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { BrowserContext } from 'playwright-core'
import { retryKernelPreparation, type KernelProgress } from './kernel-install.js'
import {
  parsePortableState,
  restorePortableState,
  type PortableState,
} from './portable-state.js'
import { withinProfileDeadline } from './profile-deadline.js'
import { initializeStoredOrigins } from './stored-origins.js'
import { prepareBrowserProxy } from './browser-proxy.js'

export { verifySdkDependencies } from './sdk-dependencies.js'

const execFileAsync = promisify(execFile)

export interface NativeProfile {
  schema_version: 1
  id: string
  binary_path: string
  proxy: string | null
  proxy_plugin?: string | null
  binding: { profile_id: string; channel_version: string }
  settings?: WindowSettings
}

interface WindowSettings {
  platform: string
  note: string
  geoip: boolean
  timezone: string
  locale: string
  viewport: string
  fingerprintSeed: number | null
  startUrl: string
}

export function browserOptionsForWindow(
  userDataDir: string,
  record: Pick<NativeProfile, 'proxy' | 'proxy_plugin' | 'settings'>,
): Parameters<typeof launchPersistentContext>[0] {
  if (record.proxy_plugin && !record.proxy?.trim()) {
    throw new Error('PROFILE_PROXY_MISSING')
  }
  const settings = record.settings
  const viewport =
    settings?.viewport === '1440x900'
      ? { width: 1440, height: 900 }
      : settings?.viewport === '1920x1080'
        ? { width: 1920, height: 1080 }
        : undefined
  return {
    userDataDir,
    headless: false,
    ...(record.proxy ? { proxy: record.proxy } : {}),
    ...(record.proxy && (settings?.geoip ?? true) ? { geoip: true } : {}),
    ...(settings?.timezone ? { timezone: settings.timezone } : {}),
    ...(settings?.locale ? { locale: settings.locale } : {}),
    ...(viewport ? { viewport } : {}),
    ...(settings?.fingerprintSeed
      ? { args: [`--fingerprint=${settings.fingerprintSeed}`] }
      : {}),
  }
}

export function parseBrowserVersion(output: string): string {
  const match = output.match(/\b(\d+\.\d+\.\d+\.\d+(?:\.\d+)?)\b/)
  if (!match) throw new Error('BINARY_VERSION_UNKNOWN')
  return match[1]!
}

export function assertBinaryVersion(expected: string, actual: string): void {
  if (expected !== actual) throw new Error('PROFILE_ENGINE_MISMATCH')
}

export async function binaryVersion(binaryPath: string): Promise<string> {
  const { stdout } = await execFileAsync(binaryPath, ['--version'], {
    timeout: 10_000,
    windowsHide: true,
  })
  return parseBrowserVersion(stdout)
}

export async function prepareBinary(
  licenseKey?: string,
  browserVersion?: string,
  report?: (progress: KernelProgress) => void,
): Promise<{
  version: string
  binary_path: string
}> {
  return retryKernelPreparation(async () => {
    const binary_path = await ensureBinary(licenseKey, browserVersion)
    return { binary_path, version: await binaryVersion(binary_path) }
  }, report)
}

export async function validateBrowserLicense(licenseKey: string): Promise<{
  valid: boolean
  plan: string
  expires: string | null
} | null> {
  return validateLicense(licenseKey)
}

async function launchProfileContext(
  userDataDir: string,
  record: NativeProfile,
  snapshot = false,
): Promise<BrowserContext> {
  if (
    record.schema_version !== 1 ||
    !record.binding ||
    record.id !== record.binding.profile_id ||
    typeof record.binary_path !== 'string' ||
    typeof record.binding.channel_version !== 'string'
  ) {
    throw new Error('PROFILE_RECORD_INVALID')
  }
  assertBinaryVersion(
    record.binding.channel_version,
    await binaryVersion(record.binary_path),
  )
  process.env.CLOAKBROWSER_BINARY_PATH = record.binary_path
  const controller = new AbortController()
  const originalFetch = globalThis.fetch
  // SDK 0.6.3's initial GeoIP database download has no signal/deadline of its own.
  // Each profile runner owns one launch; retain existing signals and the network dispatcher.
  const launchFetch: typeof fetch = (input, init) => {
    const inherited = init?.signal ?? (input instanceof Request ? input.signal : null)
    return originalFetch(input, {
      ...init,
      signal: inherited
        ? AbortSignal.any([inherited, controller.signal])
        : controller.signal,
    })
  }
  globalThis.fetch = launchFetch
  let expired = false
  let acquired = false
  try {
    const options = {
      ...browserOptionsForWindow(
        userDataDir,
        snapshot ? { ...record, proxy: null, proxy_plugin: null } : record,
      ),
      browserVersion: record.binding.channel_version,
      launchOptions: { timeout: 60_000 },
      contextOptions: {
        offline: true,
        ...(snapshot ? { serviceWorkers: 'block' as const } : {}),
      },
      ...(snapshot
        ? {
            headless: true,
            geoip: false,
          }
        : {}),
    }
    const launch = (async () =>
      launchPersistentContext(
        await prepareBrowserProxy(options, controller.signal),
      ))().then(async (context) => {
      if (expired) {
        await context.close()
        throw new Error('PROFILE_LAUNCH_TIMEOUT')
      }
      acquired = true
      context.once('close', () => controller.abort())
      return context
    })
    return await withinProfileDeadline(launch, 60_000, 'PROFILE_LAUNCH_TIMEOUT', () => {
      expired = true
      controller.abort()
    })
  } finally {
    if (!acquired) controller.abort()
    if (globalThis.fetch === launchFetch) globalThis.fetch = originalFetch
  }
}

export async function snapshotProfile(
  userDataDir: string,
  record: NativeProfile,
): Promise<PortableState> {
  const context = await launchProfileContext(userDataDir, record, true)
  try {
    await context.route('**/*', (route) => route.abort())
    await context.setOffline(true)
    const storageState = await withinProfileDeadline(
      (async () => {
        await restorePortableState(context, userDataDir, false)
        const indexedDB = await initializeStoredOrigins(context)
        const state = await context.storageState({ indexedDB: true, opfs: true })
        const capturedOrigins = new Set(state.origins.map((origin) => origin.origin))
        if (
          [...indexedDB].some(
            ([origin, databases]) => databases.length > 0 && !capturedOrigins.has(origin),
          )
        ) {
          throw new Error('PORTABLE_STATE_ORIGIN_NOT_CAPTURED')
        }
        return {
          ...state,
          origins: state.origins.map((origin) => ({
            ...origin,
            indexedDB: indexedDB.get(origin.origin) ?? [],
          })),
        }
      })(),
      30_000,
      'PORTABLE_STATE_CAPTURE_TIMEOUT',
    )
    return parsePortableState({ schemaVersion: 1, storageState })
  } finally {
    await context.close()
  }
}

export async function openProfile(
  userDataDir: string,
  record: NativeProfile,
  commands: AsyncIterable<string>,
): Promise<void> {
  const context = await launchProfileContext(userDataDir, record)
  let onClose!: () => void
  const closed = new Promise<void>((resolve) => {
    onClose = resolve
    context.once('close', onClose)
  })
  try {
    await restorePortableState(context, userDataDir)
    await context.setOffline(false)
    process.stdout.write('NEXUS_READY\n')
    if (record.settings?.startUrl) {
      // Navigation is independent of browser readiness and of the stop command loop.
      void (async () => {
        const page = context.pages()[0] ?? (await context.newPage())
        await page.goto(record.settings!.startUrl, {
          timeout: 30_000,
          waitUntil: 'domcontentloaded',
        })
      })().catch(() => {
        process.stderr.write('PROFILE_START_URL_FAILED\n')
      })
    }
    await Promise.race([
      closed,
      (async () => {
        for await (const command of commands) {
          if (command === 'stop') break
        }
      })(),
    ])
  } finally {
    context.off('close', onClose)
    await context.close()
  }
}
