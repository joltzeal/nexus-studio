import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ensureBinary } from 'cloakbrowser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareBinary } from './profile-runtime.js'

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
  await rm(root, { recursive: true, force: true })
})

describe('activated kernel preparation', () => {
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
