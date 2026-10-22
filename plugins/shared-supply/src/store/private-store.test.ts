import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createFileStore, createMemoryStore } from './private-store.js'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-supply-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

const favorite = {
  id: '12',
  favoriteId: 'f-1',
  title: '帆布包',
  description: '',
  price: '39',
  merchantId: 'M1',
  images: [],
  coverUrl: '',
  publishedAt: null,
  savedAt: '2026-10-22T00:00:00.000Z',
  raw: { id: 12 },
}

describe('private store', () => {
  it('starts empty and is not durable in memory', async () => {
    const store = createMemoryStore()
    expect(store.durable).toBe(false)
    expect(await store.read()).toEqual({ schemaVersion: 1, favorites: [] })
  })

  it('persists a mutation and reads it back after a restart', async () => {
    const directory = await temporaryDirectory()
    const first = createFileStore(directory)
    await first.mutate((document) => {
      document.favorites.push(favorite)
    })
    expect(
      JSON.parse(await readFile(join(directory, 'shared-supply.json'), 'utf8')),
    ).toEqual({
      schemaVersion: 1,
      favorites: [favorite],
    })

    const second = createFileStore(directory)
    expect(await second.read()).toEqual({ schemaVersion: 1, favorites: [favorite] })
  })

  it('keeps the previous document when the write fails', async () => {
    const directory = await temporaryDirectory()
    const store = createFileStore(directory)
    await store.mutate((document) => {
      document.favorites.push(favorite)
    })
    // A directory where the temporary file should be makes the write fail.
    await mkdir(join(directory, 'shared-supply.json.tmp'))
    await expect(
      store.mutate((document) => {
        document.favorites = []
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect((await store.read()).favorites).toHaveLength(1)
  })

  it('fails closed on a corrupt document instead of starting empty', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'shared-supply.json'), '{ not json')
    const store = createFileStore(directory)
    await expect(store.read()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('fails closed on a document with the wrong shape', async () => {
    const directory = await temporaryDirectory()
    await writeFile(
      join(directory, 'shared-supply.json'),
      JSON.stringify({ schemaVersion: 2, favorites: [] }),
    )
    const store = createFileStore(directory)
    await expect(store.read()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})
