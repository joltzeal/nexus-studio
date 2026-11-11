import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createFileStore, emptyDocument } from './account-store.js'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const directories: string[] = []

afterEach(async () => {
  vi.mocked(readFile).mockRestore()
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('account store initialization', () => {
  it('shares an in-flight startup load with concurrent writes so stale reads cannot replace committed settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-account-load-'))
    directories.push(directory)
    const document = `${JSON.stringify(emptyDocument())}\n`
    await writeFile(join(directory, 'vinted-accounts.json'), document)
    let release = () => {}
    let reads = 0
    vi.mocked(readFile).mockImplementation(async () => {
      reads += 1
      if (reads === 1)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      return document
    })
    const store = createFileStore(directory)
    const startupRead = store.read()
    const mutation = store.mutate((draft) => {
      draft.orderWatch.settings.intervalMinutes = 15
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(reads).toBe(1)
    } finally {
      release()
      await Promise.all([startupRead, mutation])
    }
    expect((await store.read()).orderWatch.settings.intervalMinutes).toBe(15)
    vi.mocked(readFile).mockRestore()
    expect(
      (await createFileStore(directory).read()).orderWatch.settings.intervalMinutes,
    ).toBe(15)
  })

  it('can retry a failed initial read after the file is repaired', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-account-repair-'))
    directories.push(directory)
    const file = join(directory, 'vinted-accounts.json')
    await writeFile(file, 'broken')
    const store = createFileStore(directory)
    await expect(store.read()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await writeFile(file, JSON.stringify(emptyDocument()))
    expect(await store.read()).toEqual(emptyDocument())
  })
})
