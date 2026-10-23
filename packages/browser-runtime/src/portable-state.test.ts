import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserContext } from 'playwright-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restorePortableState } from './portable-state.js'

let directory: string
let imported: unknown[]
let failImport: boolean
let context: BrowserContext

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nexus-portable-state-'))
  imported = []
  failImport = false
  context = {
    async setStorageState(state: unknown) {
      imported.push(state)
      if (failImport) throw new Error('Unable to restore IndexedDB')
    },
  } as unknown as BrowserContext
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})

const storageState = {
  cookies: [
    {
      name: 'session',
      value: 'synthetic-test-session',
      domain: '.example.test',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      partitionKey: 'https://top.example.test',
      _crHasCrossSiteAncestor: true,
    },
  ],
  origins: [
    {
      origin: 'https://example.test',
      localStorage: [{ name: 'account', value: 'synthetic-test-account' }],
      indexedDB: [
        {
          name: 'auth',
          version: 2,
          stores: [
            {
              name: 'tokens',
              autoIncrement: false,
              keyPath: 'id',
              indexes: [],
              records: [
                {
                  valueEncoded: {
                    o: [
                      { k: 'id', v: 'token' },
                      { k: 'expiry', v: { d: '2030-01-01T00:00:00.000Z' } },
                    ],
                    id: 1,
                  },
                },
              ],
            },
          ],
        },
      ],
      opfs: [
        { type: 'directory', path: 'files' },
        { type: 'file', path: 'files/session.bin', base64: 'AAEC' },
      ],
    },
  ],
}

describe('managed portable state restore', () => {
  it('does nothing when no managed sidecar exists', async () => {
    await restorePortableState(context, join(directory, 'user-data'))
    expect(imported).toEqual([])
  })

  it('passes complete cookies, encoded IndexedDB and OPFS to the public API then consumes the sidecar', async () => {
    const path = join(directory, 'portable-state.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, storageState }))
    await restorePortableState(context, join(directory, 'user-data'))
    expect(imported).toEqual([storageState])
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await restorePortableState(context, join(directory, 'user-data'))
    expect(imported).toHaveLength(1)
  })

  it('retains the original sidecar when the browser rejects storage', async () => {
    const path = join(directory, 'portable-state.json')
    const bytes = JSON.stringify({ schemaVersion: 1, storageState })
    await writeFile(path, bytes)
    failImport = true
    await expect(
      restorePortableState(context, join(directory, 'user-data')),
    ).rejects.toThrow('PORTABLE_STATE_RESTORE_FAILED')
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })

  it('can restore for offline recapture while retaining the pending import for normal launch', async () => {
    const path = join(directory, 'portable-state.json')
    const bytes = JSON.stringify({ schemaVersion: 1, storageState })
    await writeFile(path, bytes)
    await restorePortableState(context, join(directory, 'user-data'), false)
    expect(imported).toEqual([storageState])
    expect(await readFile(path, 'utf8')).toBe(bytes)
    await restorePortableState(context, join(directory, 'user-data'))
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains the sidecar when the public restore API stalls past its deadline', async () => {
    vi.useFakeTimers()
    const path = join(directory, 'portable-state.json')
    const bytes = JSON.stringify({ schemaVersion: 1, storageState })
    await writeFile(path, bytes)
    context.setStorageState = async (state) => {
      imported.push(state)
      await new Promise<void>(() => {})
    }
    const restoration = restorePortableState(context, join(directory, 'user-data'))
    const result = expect(restoration).rejects.toThrow('PORTABLE_STATE_RESTORE_FAILED')
    await vi.waitFor(() => expect(imported).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(30_000)
    await result
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })

  it.each([
    { schemaVersion: 2, storageState },
    { schemaVersion: 1, storageState: { cookies: [], origins: [], sessionStorage: [] } },
    {
      schemaVersion: 1,
      storageState: {
        cookies: [],
        origins: [{ origin: 'file:///tmp/private', localStorage: [] }],
      },
    },
    {
      schemaVersion: 1,
      storageState: {
        cookies: [],
        origins: [{ origin: 'https://user:pass@example.test', localStorage: [] }],
      },
    },
    {
      schemaVersion: 1,
      storageState: {
        cookies: [],
        origins: [
          { origin: 'https://example.test', localStorage: [], sessionStorage: [] },
        ],
      },
    },
    {
      schemaVersion: 1,
      storageState: {
        cookies: [{ ...storageState.cookies[0], unsupportedCookieAttribute: true }],
        origins: [],
      },
    },
    {
      schemaVersion: 1,
      storageState: {
        cookies: [],
        origins: [
          {
            origin: 'https://example.test',
            localStorage: [],
            indexedDB: [{ name: 'broken', version: 1, stores: 'invalid' }],
          },
        ],
      },
    },
    {
      schemaVersion: 1,
      storageState: {
        cookies: [],
        origins: [
          {
            origin: 'https://example.test',
            localStorage: [],
            indexedDB: [
              {
                name: 'future-data',
                version: 1,
                stores: [
                  {
                    name: 'records',
                    autoIncrement: false,
                    keyPath: 'id',
                    indexes: [],
                    records: [{ valueEncoded: { futureUnsupportedEncoding: true } }],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  ])(
    'rejects malformed/unsupported state without importing or consuming it: %j',
    async (value) => {
      const path = join(directory, 'portable-state.json')
      const bytes = JSON.stringify(value)
      await writeFile(path, bytes)
      await expect(
        restorePortableState(context, join(directory, 'user-data')),
      ).rejects.toThrow('PORTABLE_STATE_INVALID')
      expect(imported).toEqual([])
      expect(await readFile(path, 'utf8')).toBe(bytes)
    },
  )
})
