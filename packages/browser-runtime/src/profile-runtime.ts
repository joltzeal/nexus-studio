import { ensureBinary, launchPersistentContext, validateLicense } from 'cloakbrowser'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import type { BrowserContext, Page } from 'playwright-core'
import {
  compareKernelVersions,
  inspectKernelCache,
  isKernelVersion,
  type InstalledKernel,
} from './kernel-cache.js'
import { retryKernelPreparation, type KernelProgress } from './kernel-install.js'
import { checkLatestKernel, refreshKernelLookup } from './kernel-release.js'
import {
  parsePortableState,
  restorePortableState,
  type PortableState,
} from './portable-state.js'
import { withinProfileDeadline } from './profile-deadline.js'
import { initializeStoredOrigins } from './stored-origins.js'
import { prepareBrowserProxy } from './browser-proxy.js'
import { parseRuntimeWindow, type RuntimeWindow } from './runtime-window.js'
import { AutomationActor, automationCommandLoop } from './automation.js'

export { verifySdkDependencies } from './sdk-dependencies.js'
export { parseRuntimeWindow, type RuntimeWindow } from './runtime-window.js'

const execFileAsync = promisify(execFile)

export function browserOptionsForWindow(
  userDataDir: string,
  record: Pick<RuntimeWindow, 'proxy' | 'proxy_plugin' | 'settings'>,
  automationDebugging = false,
): Parameters<typeof launchPersistentContext>[0] {
  if (record.proxy_plugin && !record.proxy?.trim()) {
    throw new Error('PROFILE_PROXY_MISSING')
  }
  const settings = record.settings
  const viewport =
    settings.viewport === '1440x900'
      ? { width: 1440, height: 900 }
      : settings.viewport === '1920x1080'
        ? { width: 1920, height: 1080 }
        : undefined
  const cloak = settings.cloakbrowser
  const args = [
    `--fingerprint=${cloak?.nativeFingerprint ? 'off' : settings.fingerprintSeed}`,
    ...fingerprintArgs(settings),
    ...(automationDebugging
      ? ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0']
      : []),
  ]
  return {
    userDataDir,
    headless: false,
    ...(record.proxy ? { proxy: record.proxy } : {}),
    ...(record.proxy && settings.geoip ? { geoip: true } : {}),
    ...(settings.timezone ? { timezone: settings.timezone } : {}),
    ...(settings.locale ? { locale: settings.locale } : {}),
    ...(viewport ? { viewport } : {}),
    args,
  }
}

function fingerprintArgs(settings: RuntimeWindow['settings']): string[] {
  const cloak = settings.cloakbrowser
  const locale = [
    ...(settings.timezone ? [`--fingerprint-timezone=${settings.timezone}`] : []),
    ...(settings.locale ? [`--fingerprint-locale=${settings.locale}`] : []),
  ]
  if (!cloak) return locale
  return [
    ...locale,
    ...(cloak.platform ? [`--fingerprint-platform=${cloak.platform}`] : []),
    ...(cloak.gpuVendor
      ? [`--fingerprint-gpu-vendor=${cloak.gpuVendor === 'nvidia' ? 'NVIDIA' : 'Intel'}`]
      : []),
    ...(cloak.hardwareConcurrency
      ? [`--fingerprint-hardware-concurrency=${cloak.hardwareConcurrency}`]
      : []),
    ...(cloak.deviceMemory ? [`--fingerprint-device-memory=${cloak.deviceMemory}`] : []),
    ...(cloak.screenWidth ? [`--fingerprint-screen-width=${cloak.screenWidth}`] : []),
    ...(cloak.screenHeight ? [`--fingerprint-screen-height=${cloak.screenHeight}`] : []),
    ...(cloak.platformVersion
      ? [`--fingerprint-platform-version=${cloak.platformVersion}`]
      : []),
    ...(cloak.storageQuota ? [`--fingerprint-storage-quota=${cloak.storageQuota}`] : []),
    ...(cloak.taskbarHeight !== undefined
      ? [`--fingerprint-taskbar-height=${cloak.taskbarHeight}`]
      : []),
    ...(cloak.webrtcIp ? [`--fingerprint-webrtc-ip=${cloak.webrtcIp}`] : []),
    ...(cloak.noise === false ? ['--fingerprint-noise=false'] : []),
    ...(cloak.allowThirdPartyCookies === true ? ['--fingerprint-allow-3p-cookies'] : []),
    ...(cloak.sapiVoices === false ? ['--fingerprint-sapi-voices=false'] : []),
    ...(cloak.maxTouchPoints !== undefined
      ? [`--fingerprint-max-touch-points=${cloak.maxTouchPoints}`]
      : []),
    ...(cloak.searchEngine ? [`--fingerprint-search-engine=${cloak.searchEngine}`] : []),
    ...(cloak.transparentProxy === true ? ['--fingerprint-transparent-proxy'] : []),
    ...(cloak.transparentProxy === true && cloak.transparentProxyDns
      ? [`--fingerprint-transparent-proxy-dns=${cloak.transparentProxyDns}`]
      : []),
    ...(cloak.portableCookies === true ? ['--fingerprint-portable-cookies'] : []),
  ]
}

export function parseBrowserVersion(output: string): string {
  const match = output.match(/(?<![\w.])(\d+\.\d+\.\d+\.\d+(?:\.\d+)?)(?![\w.])/)
  if (!match) throw new Error('BINARY_VERSION_UNKNOWN')
  return match[1]!
}

export function assertBinaryVersion(expected: string, actual: string): void {
  // Chromium can omit the package revision in --version. Package identity is
  // checked separately against the explicitly bound full kernel version.
  if (
    expected !== actual &&
    !(actual.split('.').length === 4 && expected.startsWith(`${actual}.`))
  ) {
    throw new Error('PROFILE_ENGINE_MISMATCH')
  }
}

export async function binaryVersion(binaryPath: string): Promise<string> {
  const { stdout } = await execFileAsync(binaryPath, ['--version'], {
    timeout: 10_000,
    windowsHide: true,
  })
  return parseBrowserVersion(stdout)
}

function requireActivation(licenseKey: string | undefined): string {
  const key = licenseKey?.trim()
  if (!key) throw new Error('ACTIVATION_REQUIRED')
  return key
}

async function installedKernel(binaryPath: string): Promise<InstalledKernel> {
  const cacheDir = process.env.CLOAKBROWSER_CACHE_DIR
  if (!cacheDir) throw new Error('KERNEL_CACHE_UNCONFIGURED')
  const inventory = await inspectKernelCache(cacheDir)
  const kernel = inventory.installed.find(
    (entry) => resolve(entry.binaryPath) === resolve(binaryPath),
  )
  if (!kernel) throw new Error('PROFILE_ENGINE_UNSUPPORTED')
  return kernel
}

export async function prepareBinary(
  licenseKey: string | undefined,
  browserVersion?: string,
  report?: (progress: KernelProgress) => void,
): Promise<{
  version: string
  binary_path: string
}> {
  if (browserVersion !== undefined && !isKernelVersion(browserVersion)) {
    throw new Error('KERNEL_VERSION_INVALID')
  }
  const key = requireActivation(licenseKey)
  return retryKernelPreparation(async () => {
    const binary_path = await ensureBinary(key, browserVersion, 'stable')
    const kernel = await installedKernel(binary_path)
    if (browserVersion && kernel.version !== browserVersion) {
      throw new Error('PROFILE_ENGINE_MISMATCH')
    }
    const version = await binaryVersion(binary_path)
    assertBinaryVersion(kernel.version, version)
    return { binary_path, version }
  }, report)
}

export async function downloadBinary(
  licenseKey: string | undefined,
  browserVersion?: string,
  report?: (progress: KernelProgress) => void,
): ReturnType<typeof prepareBinary> {
  return browserVersion === undefined
    ? downloadLatestBinary(licenseKey, report)
    : prepareBinary(licenseKey, browserVersion, report)
}

export async function downloadLatestBinary(
  licenseKey: string | undefined,
  report?: (progress: KernelProgress) => void,
): ReturnType<typeof prepareBinary> {
  const key = requireActivation(licenseKey)
  const cacheDir = process.env.CLOAKBROWSER_CACHE_DIR
  if (!cacheDir) throw new Error('KERNEL_CACHE_UNCONFIGURED')
  const latest = await checkLatestKernel()
  await refreshKernelLookup(cacheDir)
  const binary = await prepareBinary(key, undefined, report)
  const installed = await installedKernel(binary.binary_path)
  if (compareKernelVersions(installed.version, latest.version) < 0) {
    throw new Error('KERNEL_LATEST_UNAVAILABLE')
  }
  return binary
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
  record: RuntimeWindow,
  snapshot = false,
  sessionId?: string,
): Promise<BrowserContext> {
  parseRuntimeWindow(record)
  const licenseKey = requireActivation(process.env.CLOAKBROWSER_LICENSE_KEY)
  const kernel = await installedKernel(record.binary_path)
  if (kernel.version !== record.kernel_version) {
    throw new Error('PROFILE_ENGINE_MISMATCH')
  }
  assertBinaryVersion(record.kernel_version, await binaryVersion(record.binary_path))
  process.env.CLOAKBROWSER_BINARY_PATH = record.binary_path
  const controller = new AbortController()
  const originalFetch = globalThis.fetch
  // Each runner owns one launch. Keep SDK network requests inside its lifetime
  // while retaining existing signals and the application network dispatcher.
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
        !snapshot,
      ),
      licenseKey,
      browserVersion: record.kernel_version,
      releaseChannel: 'stable' as const,
      launchOptions: { timeout: 60_000, executablePath: record.binary_path },
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
    if (sessionId) options.args = [...(options.args ?? []), `--raccoon-session-id=${sessionId}`]
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
  record: RuntimeWindow,
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
  record: RuntimeWindow,
  commands: AsyncIterable<string>,
  sessionId?: string,
): Promise<void> {
  const context = await launchProfileContext(userDataDir, record, false, sessionId)
  let onClose!: () => void
  const closed = new Promise<void>((resolve) => {
    onClose = resolve
    context.once('close', onClose)
  })
  let removePageListeners: (() => void) | undefined
  try {
    await restorePortableState(context, userDataDir)
    await context.setOffline(false)
    const lastTabClosed = new Promise<void>((resolve) => {
      const watched = new Set<Page>()
      let timer: ReturnType<typeof setTimeout> | undefined
      const watch = (page: Page) => {
        clearTimeout(timer)
        watched.add(page)
        page.once('close', onTabClose)
      }
      const onTabClose = (page: Page) => {
        watched.delete(page)
        if (context.pages().length !== 0) return
        clearTimeout(timer)
        // Chromium may replace a page while moving it between windows.
        timer = setTimeout(() => {
          if (context.pages().length === 0) resolve()
        }, 250)
      }
      context.on('page', watch)
      for (const page of context.pages()) watch(page)
      removePageListeners = () => {
        clearTimeout(timer)
        context.off('page', watch)
        for (const page of watched) page.off('close', onTabClose)
      }
    })
    process.stdout.write('NEXUS_READY\n')
    let startup: Promise<unknown> | undefined
    if (record.settings.startUrl) {
      // Navigation is independent of browser readiness and of the stop command loop.
      startup = (async () => {
        const page = context.pages()[0] ?? (await context.newPage())
        await page.goto(record.settings.startUrl, {
          timeout: 30_000,
          waitUntil: 'domcontentloaded',
        })
      })().catch(() => {
        process.stderr.write('PROFILE_START_URL_FAILED\n')
      })
    }
    const actor = new AutomationActor(context, startup)
    await Promise.race([closed, lastTabClosed, automationCommandLoop(actor, commands)])
  } finally {
    removePageListeners?.()
    context.off('close', onClose)
    await context.close()
  }
}
