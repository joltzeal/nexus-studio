import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectPluginResources } from './plugin-resources.mjs'

describe('declared plugin resources', () => {
  it('collects only declared built resources with package-relative paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'raccoon-resource-'))
    try {
      await mkdir(join(directory, 'resources/vinted'), { recursive: true })
      await writeFile(
        join(directory, 'resources/vinted/catalog.json'),
        '{"schemaVersion":1}',
      )
      const files = await collectPluginResources(directory, [
        'resources/vinted/catalog.json',
      ])
      expect(files.map((file) => file.path)).toEqual(['resources/vinted/catalog.json'])
      expect(files[0].data.toString()).toBe('{"schemaVersion":1}')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    '../secret',
    '/tmp/secret',
    'resources/../secret',
    'bootstrap.cjs',
    'resources\\secret',
  ])('rejects resource path escape %s', async (path) => {
    await expect(collectPluginResources('/tmp', [path])).rejects.toThrow()
  })

  it('rejects symbolic links instead of packaging another file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'raccoon-resource-link-'))
    try {
      await mkdir(join(directory, 'resources'))
      await writeFile(join(directory, 'secret'), 'private')
      await symlink('../secret', join(directory, 'resources/catalog.json'))
      await expect(
        collectPluginResources(directory, ['resources/catalog.json']),
      ).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
