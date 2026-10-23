import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  kernelFailure,
  kernelProgressFromLog,
  retryKernelPreparation,
} from './kernel-install.js'

afterEach(() => vi.useRealTimers())

describe('first-install kernel failures', () => {
  it('retains a nested connection failure without exposing credentials or URLs', () => {
    const error = new Error(
      'Pro binary unavailable: cb_secret https://host/?token=secret',
      {
        cause: new TypeError('fetch failed', {
          cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }),
        }),
      },
    )
    const failure = kernelFailure(error)
    expect(failure.code).toBe('NETWORK')
    expect(failure.retryable).toBe(true)
    expect(failure.message).toContain('ECONNRESET')
    expect(JSON.stringify(failure)).not.toMatch(/cb_secret|token=secret|https:/)
  })

  it('distinguishes missing download or verification files from an invalid key', () => {
    expect(kernelFailure(new Error('Download failed: HTTP 404 Not Found')).code).toBe(
      'NOT_FOUND',
    )
    expect(
      kernelFailure(new Error('Could not fetch the signed SHA256SUMS (Error: HTTP 404)'))
        .code,
    ).toBe('MANIFEST_UNAVAILABLE')
    expect(kernelFailure(new Error('license key is invalid or expired')).code).toBe(
      'ACTIVATION',
    )
  })

  it('does not retry a signature, checksum or permission failure', async () => {
    for (const message of [
      'SHA256SUMS signature verification failed',
      'Checksum verification failed',
      'Version mismatch in signed Pro SHA256SUMS',
      'EACCES: permission denied',
    ]) {
      let attempts = 0
      await expect(
        retryKernelPreparation(async () => {
          attempts++
          throw new Error(message)
        }),
      ).rejects.toThrow(message)
      expect(attempts).toBe(1)
    }
  })

  it('recovers a transient first-install error and returns the prepared binary', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const phases: string[] = []
    const preparing = retryKernelPreparation(
      async () => {
        attempts++
        if (attempts < 3) {
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
          })
        }
        return { version: '155.0.8059.39.1', binary_path: '/cache/chrome' }
      },
      (progress) => phases.push(progress.phase),
    )
    await vi.runAllTimersAsync()
    await expect(preparing).resolves.toEqual({
      version: '155.0.8059.39.1',
      binary_path: '/cache/chrome',
    })
    expect(attempts).toBe(3)
    expect(phases.filter((phase) => phase === 'retrying')).toHaveLength(2)
  })

  it('stops after three transient failures', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const preparing = retryKernelPreparation(async () => {
      attempts++
      throw new Error('Could not determine latest Pro version from server')
    })
    const assertion = expect(preparing).rejects.toThrow('Could not determine')
    await vi.runAllTimersAsync()
    await assertion
    expect(attempts).toBe(3)
  })
})

describe('kernel preparation progress', () => {
  it('only reports observed download bytes and real verification stages', () => {
    expect(
      kernelProgressFromLog('[cloakbrowser] Download progress: 39% (63/162 MB)'),
    ).toMatchObject({
      phase: 'downloading',
      percent: 39,
      downloadedMb: 63,
      totalMb: 162,
    })
    expect(kernelProgressFromLog('[cloakbrowser] Download complete: 162 MB')).toEqual({
      phase: 'verifying',
    })
    expect(kernelProgressFromLog('[cloakbrowser] Extracting to /cache/version')).toEqual({
      phase: 'extracting',
    })
    expect(kernelProgressFromLog('some unrelated log')).toBeNull()
    expect(
      kernelProgressFromLog('[cloakbrowser] Download progress: 900% (900/1 MB)'),
    ).toBeNull()
  })
})
