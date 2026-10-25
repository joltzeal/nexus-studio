import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isKernelVersion, kernelPlatform } from './kernel-cache.js'

const VERSION_URL = 'https://cloakbrowser.dev/api/download/version'
const MAX_RESPONSE_BYTES = 16 * 1024

export interface KernelRelease {
  version: string
  platform: string
  checkedAt: string
}

async function readRelease(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('KERNEL_RELEASE_INVALID')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error('KERNEL_RELEASE_INVALID')
      chunks.push(value)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      throw new Error('KERNEL_RELEASE_INVALID')
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Read current stable metadata without downloading or using the SDK's hourly cache. */
export async function checkLatestKernel(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<KernelRelease> {
  const tag = kernelPlatform(platform, arch)
  const response = await fetch(VERSION_URL, {
    headers: { Accept: 'application/json', 'X-Platform': tag },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`Kernel version request failed: HTTP ${response.status}`)
  }
  const value = await readRelease(response)
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    !isKernelVersion(value.version) ||
    ('resolved_channel' in value && value.resolved_channel !== 'stable') ||
    ('requested_channel' in value && value.requested_channel !== 'stable')
  ) {
    throw new Error('KERNEL_RELEASE_INVALID')
  }
  return { version: value.version, platform: tag, checkedAt: new Date().toISOString() }
}

/** SDK 0.6.3 caches these lookups for an hour; explicit downloads must refresh them. */
export async function refreshKernelLookup(cacheDir: string): Promise<void> {
  const tag = kernelPlatform()
  for (const prefix of ['.last_pro_version_check_', '.last_pro_version_resolution_']) {
    await rm(join(cacheDir, `${prefix}${tag}`), { force: true })
  }
}
