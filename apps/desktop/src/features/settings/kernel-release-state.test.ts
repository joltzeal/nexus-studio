import { describe, expect, it } from 'vitest'
import type { KernelStatus } from '@/lib/platform/native-kernels'
import { kernelAvailability } from './kernel-release-state'

const release = {
  version: '155.0.1.2.10',
  platform: 'darwin-arm64',
  checkedAt: '2026-10-25T10:00:00Z',
}
function inventory(versions: string[], platform = release.platform): KernelStatus {
  return {
    platform,
    cacheDir: '/synthetic/cache',
    installed: versions.map((version) => ({
      version,
      binaryPath: `/synthetic/cache/${version}/browser`,
    })),
    activationConfigured: true,
    download: {
      phase: 'idle',
      percent: null,
      downloadedMb: null,
      totalMb: null,
      attempt: null,
      version: null,
      error: null,
    },
  }
}

describe('latest kernel availability', () => {
  it('does not claim anything is current without both a release and matching local platform', () => {
    expect(kernelAvailability(null, inventory([release.version]))).toBe('unknown')
    expect(kernelAvailability(release, null)).toBe('unknown')
    expect(kernelAvailability(release, inventory([release.version], 'windows-x64'))).toBe(
      'unknown',
    )
  })

  it('identifies an empty cache or an older package revision as downloadable', () => {
    expect(kernelAvailability(release, inventory([]))).toBe('downloadable')
    expect(kernelAvailability(release, inventory(['155.0.1.2.9']))).toBe('downloadable')
    expect(kernelAvailability(release, inventory(['155.0.1.2']))).toBe('downloadable')
  })

  it('finds the exact installed release and distinguishes an already-newer local package', () => {
    expect(kernelAvailability(release, inventory(['155.0.1.2.9', release.version]))).toBe(
      'installed',
    )
    expect(kernelAvailability(release, inventory(['155.0.1.2.11']))).toBe('newer')
    expect(kernelAvailability(release, inventory(['156.0.1.2']))).toBe('newer')
  })
})
