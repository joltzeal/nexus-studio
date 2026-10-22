import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFERENCES, PreferencesSchema, parsePreferences } from './index.js'

describe('preferences contract', () => {
  it('parses the canonical Rust/UI fixture to the exact defaults', () => {
    const fixture: unknown = JSON.parse(
      readFileSync(new URL('../fixtures/preferences.json', import.meta.url), 'utf8'),
    )
    expect(parsePreferences(fixture)).toEqual(DEFAULT_PREFERENCES)
    expect(Object.isFrozen(DEFAULT_PREFERENCES)).toBe(true)
  })

  it('trims names and accepts both length boundaries', () => {
    expect(
      parsePreferences({ ...DEFAULT_PREFERENCES, workspaceName: '  我的工作室  ' })
        .workspaceName,
    ).toBe('我的工作室')
    for (const workspaceName of ['a', 'a'.repeat(60)]) {
      expect(
        parsePreferences({ ...DEFAULT_PREFERENCES, workspaceName }).workspaceName,
      ).toBe(workspaceName)
    }
  })

  it.each([
    { unexpected: true },
    { schemaVersion: 2 },
    { schemaVersion: '1' },
    { theme: 'auto' },
    { accent: 'blue' },
    { density: 'dense' },
    { reducedMotion: 'false' },
    { workspaceName: '' },
    { workspaceName: ' \t\n ' },
    { workspaceName: 'a'.repeat(61) },
    { workspaceName: null },
  ])('rejects invalid or unknown preferences: %j', (overrides) => {
    expect(
      PreferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, ...overrides }).success,
    ).toBe(false)
  })

  it('requires every field instead of silently filling persisted data', () => {
    expect(PreferencesSchema.safeParse({}).success).toBe(false)
    expect(PreferencesSchema.safeParse(null).success).toBe(false)
  })
})
