import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createFileStore, createMemoryStore } from './private-store.js'

describe('email private store', () => {
  it('serializes concurrent mutations and survives a fresh store instance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-email-store-'))
    try {
      const store = createFileStore(directory)
      await Promise.all([
        store.mutate((document) => {
          document.settings.intervalMinutes = 15
        }),
        store.mutate((document) => {
          document.settings.autoRefresh = false
        }),
      ])
      expect((await createFileStore(directory).read()).settings).toEqual({
        autoRefresh: false,
        intervalMinutes: 15,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps the previous memory document when a mutation or validation fails', async () => {
    const store = createMemoryStore()
    await expect(
      store.mutate((document) => {
        document.settings.intervalMinutes = 1
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect((await store.read()).settings.intervalMinutes).toBe(60)
    await expect(
      store.mutate((document) => {
        document.settings.intervalMinutes = 20
        throw new Error('operation rejected')
      }),
    ).rejects.toThrow('operation rejected')
    expect((await store.read()).settings.intervalMinutes).toBe(60)
  })

  it('fails closed on corrupt storage instead of discarding mailboxes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-email-corrupt-'))
    try {
      const file = join(directory, 'email.json')
      await writeFile(file, '{broken')
      const store = createFileStore(directory)
      await expect(store.read()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
      await expect(
        store.mutate((document) => {
          document.settings.autoRefresh = false
        }),
      ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
      expect(await readFile(file, 'utf8')).toBe('{broken')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not swap in-memory state when the file cannot be replaced', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-email-write-'))
    try {
      const store = createFileStore(directory)
      await store.mutate(() => undefined)
      const original = await store.read()
      await rm(directory, { recursive: true })
      await writeFile(directory, 'blocks directory creation')
      await expect(
        store.mutate((document) => {
          document.settings.intervalMinutes = 30
        }),
      ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
      expect(await store.read()).toEqual(original)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
