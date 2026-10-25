import {
  isKernelVersion,
  type KernelRelease,
  type KernelStatus,
} from '@/lib/platform/native-kernels'

export function kernelAvailability(
  release: KernelRelease | null,
  status: KernelStatus | null,
): 'unknown' | 'downloadable' | 'installed' | 'newer' {
  if (!release || !status || release.platform !== status.platform) return 'unknown'
  if (status.installed.some((entry) => entry.version === release.version)) {
    return 'installed'
  }
  const target = release.version.split('.').map(BigInt)
  const newer = status.installed.some((entry) => {
    if (!isKernelVersion(entry.version)) return false
    const current = entry.version.split('.').map(BigInt)
    for (let i = 0; i < Math.max(current.length, target.length); i++) {
      const difference = (current[i] ?? 0n) - (target[i] ?? 0n)
      if (difference !== 0n) return difference > 0n
    }
    return false
  })
  return newer ? 'newer' : 'downloadable'
}
