import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFERENCES, type Preferences } from '@nexus/contracts'
import {
  createPreferenceWriter,
  createPreviewRepository,
  type PreferenceRepository,
} from './preferences'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  }
}

describe('preview preferences', () => {
  it('roundtrips changes without exposing a desktop storage fallback', async () => {
    const storage = memoryStorage()
    const repository = createPreviewRepository(storage)
    expect(await repository.load()).toEqual(DEFAULT_PREFERENCES)
    const next: Preferences = { ...DEFAULT_PREFERENCES, theme: 'dark' }
    await repository.save(next)
    expect(await createPreviewRepository(storage).load()).toEqual(next)
    expect(storage.key(0)).toBe('nexus.preview.preferences.v1')
  })

  it('preserves incompatible data and reports an error instead of resetting it', async () => {
    const storage = memoryStorage()
    storage.setItem('nexus.preview.preferences.v1', '{"schemaVersion":99}')
    await expect(createPreviewRepository(storage).load()).rejects.toThrow()
    expect(storage.getItem('nexus.preview.preferences.v1')).toBe('{"schemaVersion":99}')
  })
})

describe('preference writer', () => {
  it('serializes rapid updates so an older slow write cannot overwrite a newer one', async () => {
    const written: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const repository: PreferenceRepository = {
      load: async () => ({ ...DEFAULT_PREFERENCES }),
      save: async (preferences) => {
        if (preferences.theme === 'dark') await firstGate
        written.push(preferences.theme)
        return preferences
      },
    }
    const write = createPreferenceWriter(repository)
    const first = write({ ...DEFAULT_PREFERENCES, theme: 'dark' })
    const second = write({ ...DEFAULT_PREFERENCES, theme: 'light' })
    await Promise.resolve()
    expect(written).toEqual([])
    releaseFirst?.()
    await Promise.all([first, second])
    expect(written).toEqual(['dark', 'light'])
  })

  it('allows retry after a rejected write', async () => {
    let attempt = 0
    const write = createPreferenceWriter({
      load: async () => ({ ...DEFAULT_PREFERENCES }),
      save: async (preferences) => {
        if (++attempt === 1) throw new Error('disk unavailable')
        return preferences
      },
    })
    await expect(write({ ...DEFAULT_PREFERENCES })).rejects.toThrow('disk unavailable')
    await expect(
      write({ ...DEFAULT_PREFERENCES, accent: 'coral' }),
    ).resolves.toMatchObject({
      accent: 'coral',
    })
  })
})
