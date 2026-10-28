import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

import { createAiImagePlugin } from '../index.js'

const destination = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => destination.home,
}))
vi.mock('node:child_process', () => ({
  execFile: (
    _command: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    callback(null, join(destination.home, 'Downloads'))
  },
}))

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

it('the production plugin writes export copies into Downloads instead of its private data directory', async () => {
  destination.home = await mkdtemp(join(tmpdir(), 'nexus-download-export-'))
  directories.push(destination.home)
  const storage = join(destination.home, 'private-plugin-data')
  const instance = createAiImagePlugin({
    storageDirectory: storage,
    diagnostics: new PassThrough(),
  })
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const path = await instance.images.exportCopy(bytes, 'image/png', 'product', true)
  expect(path).toBe(join(destination.home, 'Downloads', 'Nexus AI', 'product.png'))
  expect(new Uint8Array(await readFile(path!))).toEqual(bytes)
  await expect(readdir(join(storage, 'exports'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

it('does not silently export into private storage when Downloads cannot be written', async () => {
  destination.home = await mkdtemp(join(tmpdir(), 'nexus-blocked-downloads-'))
  directories.push(destination.home)
  await mkdir(join(destination.home, 'Downloads'))
  await writeFile(join(destination.home, 'Downloads', 'Nexus AI'), 'not a directory')
  const storage = join(destination.home, 'private-plugin-data')
  const instance = createAiImagePlugin({
    storageDirectory: storage,
    diagnostics: new PassThrough(),
  })
  await expect(
    instance.images.exportCopy(new Uint8Array([1]), 'image/png', 'product'),
  ).rejects.toThrow('导出')
  await expect(readdir(join(storage, 'exports'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})
