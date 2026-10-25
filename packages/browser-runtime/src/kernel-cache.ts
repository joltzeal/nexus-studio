import { constants, type Dirent } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface InstalledKernel {
  version: string
  binaryPath: string
}

export interface KernelCache {
  cacheDir: string
  platform: string
  installed: InstalledKernel[]
}

const SUPPORTED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'windows-x64',
  'linux-arm64',
  'linux-x64',
])
const INSTALL_DIRECTORY = /^chromium-([0-9]+(?:\.[0-9]+){3,4})-pro$/

function fileSystemCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
}

function cacheReadError(): Error {
  return new Error('Unable to inspect the local browser kernel cache.')
}

export function kernelPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const tag = `${platform === 'win32' ? 'windows' : platform}-${arch}`
  if (!SUPPORTED_PLATFORMS.has(tag)) {
    throw new Error('The browser kernel platform is unsupported.')
  }
  return tag
}

export function compareKernelVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(BigInt)
  const rightParts = right.split('.').map(BigInt)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const leftPart = leftParts[index] ?? 0n
    const rightPart = rightParts[index] ?? 0n
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1
  }
  return 0
}

export async function inspectKernelCache(
  cacheDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<KernelCache> {
  const platformTag = kernelPlatform(platform, arch)
  const inventory: KernelCache = { cacheDir, platform: platformTag, installed: [] }
  let entries: Dirent[]
  try {
    entries = await readdir(cacheDir, { withFileTypes: true })
  } catch (error) {
    if (fileSystemCode(error) === 'ENOENT') return inventory
    throw cacheReadError()
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const match = INSTALL_DIRECTORY.exec(entry.name)
    const version = match?.[1]
    if (!version) continue
    const binaryPath = join(
      cacheDir,
      entry.name,
      ...(platform === 'darwin'
        ? ['Chromium.app', 'Contents', 'MacOS', 'Chromium']
        : [platform === 'win32' ? 'chrome.exe' : 'chrome']),
    )
    try {
      const info = await stat(binaryPath)
      if (!info.isFile() || info.size === 0) continue
      if (platform !== 'win32') {
        if ((info.mode & 0o111) === 0) continue
        await access(binaryPath, constants.X_OK)
      }
    } catch (error) {
      const code = fileSystemCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      throw cacheReadError()
    }
    inventory.installed.push({
      version,
      binaryPath,
    })
  }
  inventory.installed.sort(
    (left, right) =>
      compareKernelVersions(right.version, left.version) ||
      left.version.localeCompare(right.version),
  )
  return inventory
}
