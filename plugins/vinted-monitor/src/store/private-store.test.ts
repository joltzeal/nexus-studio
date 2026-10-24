import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createFileStore } from './private-store.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  )
})

describe('private store migration', () => {
  it('merges schema1 duplicates by earliest snapshot and latest valid favourite without losing unknown data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vinted-migration-'))
    directories.push(directory)
    const file = join(directory, 'vinted-monitor.json')
    const item = {
      id: '7',
      monitorId: 'b',
      title: 'later',
      price: '99',
      currency: 'EUR',
      brand: '',
      size: '',
      condition: '',
      url: 'https://www.vinted.fr/items/7',
      imageUrl: '',
      seller: '',
      listedAt: null,
      firstSeenAt: '2026-10-25T01:00:00.000Z',
      lastSeenAt: '2026-10-25T02:00:00.000Z',
      favouriteCount: 0,
      future: { b: 2 },
      conflict: 'later',
    }
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        monitors: [],
        runs: [],
        extraRoot: { x: true },
        items: [
          item,
          {
            ...item,
            monitorId: 'a',
            title: 'first',
            price: '12',
            firstSeenAt: '2026-10-25T00:00:00.000Z',
            lastSeenAt: '2026-10-25T01:00:00.000Z',
            favouriteCount: 5,
            future: { a: 1 },
            conflict: 'first',
          },
        ],
      }),
    )
    const store = createFileStore(directory)
    const migrated = await store.read()
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.items).toHaveLength(1)
    expect(migrated.items[0]).toMatchObject({
      id: 'vinted.fr:7',
      externalId: '7',
      domain: 'vinted.fr',
      title: 'first',
      price: '12',
      monitorId: 'a',
      monitorIds: ['a', 'b'],
      favouriteCount: 0,
      conflict: 'first',
      future: { a: 1, b: 2 },
      legacyRecords: expect.arrayContaining([
        expect.objectContaining({ conflict: 'later' }),
      ]),
    })
    await store.mutate(() => undefined)
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      extraRoot: { x: true },
    })
    expect(await createFileStore(directory).read()).toEqual(migrated)
  })

  it('does not overwrite unparseable or unsupported data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vinted-bad-store-'))
    directories.push(directory)
    const file = join(directory, 'vinted-monitor.json')
    for (const text of ['{bad', '{"schemaVersion":99,"items":[]}']) {
      await writeFile(file, text)
      await expect(createFileStore(directory).mutate(() => undefined)).rejects.toThrow()
      expect(await readFile(file, 'utf8')).toBe(text)
    }
  })
})
