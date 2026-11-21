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

  it('does not store a manually named workspace in 0.2', () => {
    expect(DEFAULT_PREFERENCES.schemaVersion).toBe(2)
    expect(
      PreferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, workspaceName: 'Old studio' }).success,
    ).toBe(false)
  })

  it.each([
    { unexpected: true },
    { schemaVersion: 1 },
    { schemaVersion: '1' },
    { theme: 'auto' },
    { accent: 'blue' },
    { density: 'dense' },
    { reducedMotion: 'false' },
    { workspaceName: 'Old studio' },
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
