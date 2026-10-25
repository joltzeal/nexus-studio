import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareKernelVersions, kernelPlatform } from './kernel-cache.js'
import { checkLatestKernel, refreshKernelLookup } from './kernel-release.js'
import { kernelFailure } from './kernel-install.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('latest stable kernel metadata', () => {
  it.each([
    ['darwin', 'arm64', 'darwin-arm64'],
    ['darwin', 'x64', 'darwin-x64'],
    ['win32', 'x64', 'windows-x64'],
  ] as const)(
    'uses the official platform query for %s/%s',
    async (platform, arch, tag) => {
      const fetcher = vi.fn().mockResolvedValue(
        Response.json({
          version: '155.0.8059.39.2',
          requested_channel: 'stable',
          resolved_channel: 'stable',
        }),
      )
      vi.stubGlobal('fetch', fetcher)
      const release = await checkLatestKernel(platform, arch)
      expect(release).toMatchObject({ version: '155.0.8059.39.2', platform: tag })
      expect(Number.isFinite(Date.parse(release.checkedAt))).toBe(true)
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        'https://cloakbrowser.dev/api/download/version',
        {
          headers: { Accept: 'application/json', 'X-Platform': tag },
          cache: 'no-store',
          redirect: 'error',
          signal: expect.any(AbortSignal),
        },
      )
    },
  )

  it('queries again rather than returning the previous successful version', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ version: '155.0.1.2' }))
      .mockResolvedValueOnce(Response.json({ version: '156.0.1.2' }))
    vi.stubGlobal('fetch', fetcher)
    expect((await checkLatestKernel()).version).toBe('155.0.1.2')
    expect((await checkLatestKernel()).version).toBe('156.0.1.2')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([
    null,
    {},
    { version: 155 },
    { version: 'latest' },
    { version: '155.0' },
    { version: '155.0.1.2\n' },
    { version: '1'.repeat(49) + '.0.1.2' },
    { version: '155.0.1.2', resolved_channel: 'preview' },
    { version: '155.0.1.2', requested_channel: 'preview' },
  ])('rejects invalid or non-stable metadata %#', async (value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(value)))
    await expect(checkLatestKernel()).rejects.toThrow('KERNEL_RELEASE_INVALID')
  })

  it('bounds metadata size and does not expose response contents', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('private'.repeat(4_000))),
    )
    const error = await checkLatestKernel().catch((cause: unknown) => cause)
    expect(kernelFailure(error)).toEqual({
      code: 'VERSION',
      message: '最新内核版本信息无效，请稍后重新检查。',
      retryable: true,
    })
  })

  it('does not treat a failed check as up to date or return a cached version', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ version: '155.0.1.2' }))
        .mockResolvedValueOnce(
          new Response('private upstream diagnostics', { status: 503 }),
        ),
    )
    await checkLatestKernel()
    const error = await checkLatestKernel().catch((cause: unknown) => cause)
    expect(kernelFailure(error)).toMatchObject({ code: 'NETWORK', retryable: true })
    expect(String(error)).not.toContain('private')
  })

  it('refreshes only the SDK stable lookup metadata, preserving installed packages and activation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-version-cache-'))
    const tag = kernelPlatform()
    const remove = [
      `.last_pro_version_check_${tag}`,
      `.last_pro_version_resolution_${tag}`,
    ]
    const keep = ['latest_pro_version_' + tag, 'license.key', '.license_cache', 'browser']
    try {
      for (const name of [...remove, ...keep]) {
        await writeFile(join(directory, name), 'synthetic preserved data')
      }
      await refreshKernelLookup(directory)
      expect((await readdir(directory)).sort()).toEqual([...keep].sort())
      for (const name of keep) {
        expect(await readFile(join(directory, name), 'utf8')).toBe(
          'synthetic preserved data',
        )
      }
      await refreshKernelLookup(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('compares full numeric revisions without lexicographic or integer precision loss', () => {
    expect(compareKernelVersions('155.0.1.2.10', '155.0.1.2.9')).toBe(1)
    expect(compareKernelVersions('155.0.1.2', '155.0.1.2.1')).toBe(-1)
    expect(compareKernelVersions('155.0.1.2', '155.0.1.2.0')).toBe(0)
    expect(
      compareKernelVersions('10000000000000001.0.1.2', '10000000000000000.0.1.2'),
    ).toBe(1)
  })
})
