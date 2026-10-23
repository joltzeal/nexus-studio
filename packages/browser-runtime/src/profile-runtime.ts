import { ensureBinary, launchPersistentContext, validateLicense } from 'cloakbrowser'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { retryKernelPreparation, type KernelProgress } from './kernel-install.js'

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
    ...(settings?.geoip ? { geoip: true } : {}),
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

async function binaryVersion(binaryPath: string): Promise<string> {
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

export async function openProfile(
  userDataDir: string,
  record: NativeProfile,
  commands: AsyncIterable<string>,
): Promise<void> {
  if (
    record.schema_version !== 1 ||
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
  const context = await launchPersistentContext(
    browserOptionsForWindow(userDataDir, record),
  )
  try {
    const page = context.pages()[0] ?? (await context.newPage())
    if (record.settings?.startUrl) await page.goto(record.settings.startUrl)
  } catch (error) {
    await context.close()
    throw error
  }
  process.stdout.write('NEXUS_READY\n')
  try {
    for await (const command of commands) {
      if (command === 'stop') break
    }
  } finally {
    await context.close()
  }
}
