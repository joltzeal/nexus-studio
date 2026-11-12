import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createFileStore, createMemoryStore, emptyDocument } from './private-store.js'

describe('email private store', () => {
  it('normalizes legacy account reception fields only at file load and preserves credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-email-legacy-account-'))
    try {
      const account = {
        id: '00000000-0000-4000-8000-000000000002',
        provider: 'microsoft',
        transport: 'graph',
        email: 'legacy@example.test',
        password: 'synthetic-password',
        clientId: '00000000-0000-4000-8000-000000000001',
        refreshToken: 'synthetic-rotated',
        accessToken: 'synthetic-access',
        accessExpiresAt: '2026-11-13T01:00:00.000Z',
        credentialRevision: '00000000-0000-4000-8000-000000000003',
        note: 'Keep this',
        enabled: true,
        status: 'active',
        lastAttemptAt: '2026-11-12T01:00:00.000Z',
        lastRefreshedAt: '2026-11-12T01:00:00.000Z',
        lastRotatedAt: '2026-11-12T01:00:00.000Z',
        nextRefreshAt: '2026-11-12T01:55:00.000Z',
        refreshRequested: true,
        consecutiveFailures: 0,
        lastError: null,
        lastErrorCode: null,
        createdAt: '2026-11-12T01:00:00.000Z',
        updatedAt: '2026-11-12T01:00:00.000Z',
      }
      const file = join(directory, 'email.json')
      await writeFile(file, JSON.stringify({ ...emptyDocument(), accounts: [account] }))
      const store = createFileStore(directory)
      const normalized = (await store.read()).accounts[0]!
      expect(normalized).toMatchObject({
        ...account,
        receiveRequested: false,
        receiveFailures: 0,
        reception: {
          lastCheckedAt: null,
          nextCheckAt: null,
          inbox: null,
          junkemail: null,
        },
      })
      await store.mutate(() => {})
      expect((await createFileStore(directory).read()).accounts[0]).toEqual(normalized)
      await expect(
        store.mutate((document) => {
          Reflect.deleteProperty(document.accounts[0]!, 'receiveRequested')
        }),
      ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
      expect((await store.read()).accounts[0]).toEqual(normalized)
      await writeFile(
        file,
        JSON.stringify({
          ...emptyDocument(),
          accounts: [{ ...account, receiveFailures: -1 }],
        }),
      )
      await expect(createFileStore(directory).read()).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('normalizes absent reception settings at load while rejecting invalid explicit settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-email-normalize-'))
    try {
      const legacy = {
        ...emptyDocument(),
        settings: { autoRefresh: false, intervalMinutes: 15 },
      }
      const file = join(directory, 'email.json')
      await writeFile(file, JSON.stringify(legacy))
      const store = createFileStore(directory)
      expect((await store.read()).settings).toEqual({
        autoRefresh: false,
        intervalMinutes: 15,
        autoReceive: true,
        receiveIntervalMinutes: 1,
      })
      await store.mutate(() => {})
      expect((await createFileStore(directory).read()).settings).toEqual(
        (await store.read()).settings,
      )
      await writeFile(
        file,
        JSON.stringify({
          ...legacy,
          settings: { ...legacy.settings, autoReceive: 'true' },
        }),
      )
      await expect(createFileStore(directory).read()).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
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
        autoReceive: true,
        receiveIntervalMinutes: 1,
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
