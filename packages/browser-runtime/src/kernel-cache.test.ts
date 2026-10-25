import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectKernelCache } from './kernel-cache.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('local kernel inventory', () => {
  it('represents a new machine without creating fake installed kernels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-kernels-'))
    roots.push(root)
    expect(await inspectKernelCache(join(root, 'missing'), 'darwin', 'arm64')).toEqual({
      cacheDir: join(root, 'missing'),
      platform: 'darwin-arm64',
      installed: [],
    })
  })

  it('lists complete executable installs and ignores partial or broken downloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-kernels-'))
    roots.push(root)
    for (const name of [
      'chromium-155.0.8059.39.2',
      'chromium-151.0.7922.108.3-pro',
      'chromium-155.0.8059.39.1-pro',
      'chromium-156.0.1.2-pro.partial-123',
      'chromium-157.0.1.2-pro',
    ]) {
      const folder = join(root, name, 'Chromium.app/Contents/MacOS')
      await mkdir(folder, { recursive: true })
      if (name !== 'chromium-157.0.1.2-pro') {
        await writeFile(join(folder, 'Chromium'), '#!/bin/sh\n')
        await chmod(join(folder, 'Chromium'), 0o755)
      }
    }
    const result = await inspectKernelCache(root, 'darwin', 'arm64')
    expect(result.installed.map(({ version }) => version)).toEqual([
      '155.0.8059.39.1',
      '151.0.7922.108.3',
    ])
  })

  it('recognizes only supported Windows packages with a nonempty executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-kernels-'))
    roots.push(root)
    for (const name of [
      'chromium-155.0.1.2-pro',
      'chromium-155.0.1.2',
      'chromium-156.0.1.2-pro',
    ]) {
      const folder = join(root, name)
      await mkdir(folder)
      await writeFile(
        join(folder, 'chrome.exe'),
        name === 'chromium-156.0.1.2-pro' ? '' : 'synthetic executable',
      )
    }
    expect((await inspectKernelCache(root, 'win32', 'x64')).installed).toEqual([
      {
        version: '155.0.1.2',
        binaryPath: join(root, 'chromium-155.0.1.2-pro', 'chrome.exe'),
      },
    ])
  })
})
