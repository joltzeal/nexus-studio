import type { BrowserContext } from 'playwright-core'
import { describe, expect, it, vi } from 'vitest'
import { initializeStoredOrigins } from './stored-origins.js'

vi.mock('./indexeddb-capture.js', () => ({
  captureIndexedDB: async () => [],
}))

function contextWithSites(groups: unknown) {
  const visited: string[] = []
  let closed = false
  const context = {
    async newPage() {
      return {
        async goto(url: string) {
          visited.push(url)
        },
        async evaluate() {
          return groups
        },
        async route() {},
        async close() {
          closed = true
        },
      }
    },
  } as unknown as BrowserContext
  return {
    context,
    visited,
    get closed() {
      return closed
    },
  }
}

describe('persisted origin discovery', () => {
  it('registers cookie-only and storage-only origins even when the cookie entry has no usage', async () => {
    const browser = contextWithSites([
      {
        origins: [
          { origin: 'https://cookie.example/', numCookies: 1 },
          { origin: 'https://storage.example/', usage: 25 },
          { origin: 'https://storage.example/', usage: 100 },
        ],
      },
    ])
    await initializeStoredOrigins(browser.context)
    expect(browser.visited).toEqual([
      'chrome://settings/content/all',
      'https://cookie.example',
      'https://storage.example',
    ])
    expect(browser.closed).toBe(true)
  })

  it.each([25, undefined])(
    'fails explicitly for partitioned storage with positive or unknown usage (%s)',
    async (usage) => {
      const browser = contextWithSites([
        {
          origins: [
            {
              origin: 'https://storage.example/',
              ...(usage === undefined ? {} : { usage }),
              isPartitioned: true,
            },
          ],
        },
      ])
      await expect(initializeStoredOrigins(browser.context)).rejects.toThrow(
        'PORTABLE_STATE_PARTITIONED_STORAGE_UNSUPPORTED',
      )
      expect(browser.closed).toBe(true)
      expect(browser.visited).toEqual(['chrome://settings/content/all'])
    },
  )

  it('fails explicitly if a kernel returns an unrecognized site-data format', async () => {
    const browser = contextWithSites({ unsupportedVersion: true })
    await expect(initializeStoredOrigins(browser.context)).rejects.toThrow(
      'PORTABLE_STATE_ORIGINS_INVALID',
    )
    expect(browser.closed).toBe(true)
  })
})
