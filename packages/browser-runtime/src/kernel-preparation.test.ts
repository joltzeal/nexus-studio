import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ensureBinary } from 'cloakbrowser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadBinary, downloadLatestBinary, prepareBinary } from './profile-runtime.js'
import { kernelPlatform } from './kernel-cache.js'
import { kernelFailure } from './kernel-install.js'

vi.mock('cloakbrowser', () => ({
  ensureBinary: vi.fn(),
  launchPersistentContext: vi.fn(),
  validateLicense: vi.fn(),
}))

let root: string
let binary: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-kernel-preparation-'))
  vi.stubEnv('CLOAKBROWSER_CACHE_DIR', root)
  binary = join(
    root,
    'chromium-155.0.8059.39.2-pro',
    process.platform === 'darwin'
      ? 'Chromium.app/Contents/MacOS/Chromium'
      : process.platform === 'win32'
        ? 'chrome.exe'
        : 'chrome',
  )
  await mkdir(dirname(binary), { recursive: true })
  await writeFile(
    binary,
    `#!${process.execPath}\nconsole.log('Chromium 155.0.8059.39')\n`,
    { mode: 0o700 },
  )
  vi.mocked(ensureBinary).mockReset().mockResolvedValue(binary)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

describe('activated kernel preparation', () => {
  it.each([
    '',
    '155',
    'latest',
    '155.0.1',
    '155.0.1.2 ',
    '../155.0.1.2',
    '9'.repeat(49) + '.0.1.2',
  ])('rejects an invalid explicit version before any download (%j)', async (version) => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const error = await downloadBinary('synthetic-key', version).catch(
      (cause: unknown) => cause,
    )
    expect(kernelFailure(error)).toMatchObject({ code: 'VERSION', retryable: false })
    expect(ensureBinary).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('downloads an exact revision without querying latest or replacing another installed version', async () => {
    const older = binary.replace('155.0.8059.39.2', '154.0.8000.10.4')
    await mkdir(dirname(older), { recursive: true })
    await writeFile(
      older,
      `#!${process.execPath}\nconsole.log('Chromium 154.0.8000.10')\n`,
      {
        mode: 0o700,
      },
    )
    vi.mocked(ensureBinary).mockResolvedValue(older)
    const fetcher = vi.fn().mockRejectedValue(new Error('Latest endpoint unavailable'))
    vi.stubGlobal('fetch', fetcher)
    await expect(
      downloadBinary('synthetic-paid-key', '154.0.8000.10.4'),
    ).resolves.toEqual({
      binary_path: older,
      version: '154.0.8000.10',
    })
    expect(ensureBinary).toHaveBeenCalledExactlyOnceWith(
      'synthetic-paid-key',
      '154.0.8000.10.4',
      'stable',
    )
    expect(fetcher).not.toHaveBeenCalled()
    expect(await readdir(root)).toContain('chromium-155.0.8059.39.2-pro')
    expect(await readdir(root)).toContain('chromium-154.0.8000.10.4-pro')
  })

  it('does not fall back to latest when an exact revision is unavailable', async () => {
    vi.mocked(ensureBinary).mockRejectedValue(new Error('Download failed: HTTP 404'))
    const error = await downloadBinary('synthetic-paid-key', '154.0.8000.10.4').catch(
      (cause: unknown) => cause,
    )
    expect(kernelFailure(error)).toMatchObject({ code: 'NOT_FOUND', retryable: false })
    expect(ensureBinary).toHaveBeenCalledExactlyOnceWith(
      'synthetic-paid-key',
      '154.0.8000.10.4',
      'stable',
    )
  })

  it('rejects a binary whose display version does not belong to its package', async () => {
    await writeFile(
      binary,
      `#!${process.execPath}\nconsole.log('Chromium 154.0.8000.10')\n`,
    )
    await expect(downloadBinary('synthetic-key', '155.0.8059.39.2')).rejects.toThrow(
      'PROFILE_ENGINE_MISMATCH',
    )
    expect(ensureBinary).toHaveBeenCalledTimes(1)
  })

  it('does not check or download without activation', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(downloadLatestBinary('')).rejects.toThrow('ACTIVATION_REQUIRED')
    expect(fetcher).not.toHaveBeenCalled()
    expect(ensureBinary).not.toHaveBeenCalled()
  })

  it('refreshes stale SDK lookups before an explicit download and keeps the normal stable request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ version: '155.0.8059.39.2' })),
    )
    const marker = `.last_pro_version_check_${kernelPlatform()}`
    await writeFile(join(root, marker), '154.0.1.2')
    vi.mocked(ensureBinary).mockImplementation(async () => {
      expect(await readdir(root)).not.toContain(marker)
      return binary
    })
    expect(await downloadLatestBinary('synthetic-key')).toMatchObject({
      binary_path: binary,
      version: '155.0.8059.39',
    })
    expect(ensureBinary).toHaveBeenCalledExactlyOnceWith(
      'synthetic-key',
      undefined,
      'stable',
    )
  })

  it('does not report a cached older revision as a successful latest download', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ version: '155.0.8059.39.3' })),
    )
    await expect(downloadLatestBinary('synthetic-key')).rejects.toThrow(
      'KERNEL_LATEST_UNAVAILABLE',
    )
  })

  it('stops before SDK download when current release metadata cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')))
    await expect(downloadLatestBinary('synthetic-key')).rejects.toThrow('fetch failed')
    expect(ensureBinary).not.toHaveBeenCalled()
  })

  it.each([undefined, '', '   '])(
    'rejects missing activation before invoking the SDK (%j)',
    async (key) => {
      await expect(prepareBinary(key)).rejects.toThrow('ACTIVATION_REQUIRED')
      expect(ensureBinary).not.toHaveBeenCalled()
    },
  )

  it('requests the latest stable kernel and binds its actual display version', async () => {
    expect(await prepareBinary(' synthetic-key ')).toEqual({
      binary_path: binary,
      version: '155.0.8059.39',
    })
    expect(ensureBinary).toHaveBeenCalledExactlyOnceWith(
      'synthetic-key',
      undefined,
      'stable',
    )
  })

  it('accepts the exact package revision for a transfer even when Chrome omits it', async () => {
    await expect(
      prepareBinary('synthetic-key', '155.0.8059.39.2'),
    ).resolves.toMatchObject({
      version: '155.0.8059.39',
    })
    expect(ensureBinary).toHaveBeenCalledExactlyOnceWith(
      'synthetic-key',
      '155.0.8059.39.2',
      'stable',
    )
  })

  it('rejects a substituted package instead of silently changing an imported environment', async () => {
    await expect(prepareBinary('synthetic-key', '155.0.8059.39.1')).rejects.toThrow(
      'PROFILE_ENGINE_MISMATCH',
    )
    expect(ensureBinary).toHaveBeenCalledTimes(1)
  })

  it('rejects a complete package outside the activated channel', async () => {
    const unmanaged = binary.replace('-pro', '')
    await mkdir(dirname(unmanaged), { recursive: true })
    await writeFile(unmanaged, '#!/bin/sh\nexit 42\n', { mode: 0o700 })
    vi.mocked(ensureBinary).mockResolvedValue(unmanaged)
    await expect(prepareBinary('synthetic-key')).rejects.toThrow(
      'PROFILE_ENGINE_UNSUPPORTED',
    )
    expect(ensureBinary).toHaveBeenCalledTimes(1)
  })

  it('never retries an activation rejection without the key', async () => {
    vi.mocked(ensureBinary).mockRejectedValue(new Error('license key is invalid'))
    await expect(prepareBinary('synthetic-key')).rejects.toThrow('license key is invalid')
    expect(ensureBinary).toHaveBeenCalledExactlyOnceWith(
      'synthetic-key',
      undefined,
      'stable',
    )
  })
})
