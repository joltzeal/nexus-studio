import { describe, expect, it } from 'vitest'

import {
  asciiName,
  createUsernameAllocator,
  generateUsername,
  numberSuffix,
} from './username.js'

/** Deterministic RNG so a distribution assertion is not flaky. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const HANDLE = /^[a-z][a-z0-9._-]*$/

describe('asciiName', () => {
  it('strips combining marks', () => {
    expect(asciiName('Müller')).toBe('muller')
    expect(asciiName('Léa')).toBe('lea')
    expect(asciiName('Gonçalo')).toBe('goncalo')
    expect(asciiName('Raphaël')).toBe('raphael')
  })

  it('transliterates letters NFD cannot split', () => {
    expect(asciiName('Łukasz')).toBe('lukasz')
    expect(asciiName('Wiśniewski')).toBe('wisniewski')
    expect(asciiName('Straße')).toBe('strasse')
    expect(asciiName('Þór')).toBe('thor')
    expect(asciiName('Søren')).toBe('soren')
  })

  it('drops everything that is not a latin letter', () => {
    expect(asciiName("O'Brien-Smith 3")).toBe('obriensmith')
  })
})

describe('numberSuffix', () => {
  it('only produces 1, 2 or 4 digit numbers', () => {
    const random = seeded(7)
    for (let index = 0; index < 500; index++) {
      expect(numberSuffix(random)).toMatch(/^\d{1,2}$|^\d{4}$/)
    }
  })

  it('prefers birth-year style two digit numbers', () => {
    const random = seeded(11)
    let twoDigit = 0
    const total = 1000
    for (let index = 0; index < total; index++) {
      if (numberSuffix(random).length === 2) twoDigit++
    }
    expect(twoDigit / total).toBeGreaterThan(0.5)
  })
})

describe('generateUsername', () => {
  const pairs: Array<[string, string]> = [
    ['Marie', 'Laurent'],
    ['Łukasz', 'Wiśniewski'],
    ['Maximiliane', 'Vandenberghe'],
    ['Inês', 'Gonçalves'],
    ['James', 'Smith'],
    ['Zoë', 'de Vries'],
  ]

  it('always returns a valid handle', () => {
    const random = seeded(3)
    for (let index = 0; index < 600; index++) {
      const [first, last] = pairs[index % pairs.length] as [string, string]
      const username = generateUsername({ firstName: first, lastName: last, random })
      expect(username).toMatch(HANDLE)
      expect(username.length).toBeGreaterThanOrEqual(4)
      expect(username.length).toBeLessThanOrEqual(20)
      expect(username).not.toMatch(/^[._-]|[._-]$/)
      expect(username).not.toMatch(/[._-]{2}/)
    }
  })

  it('keeps a long name inside the length window instead of truncating the separator', () => {
    const username = generateUsername({
      firstName: 'Maximiliane',
      lastName: 'Vandenberghe',
      random: seeded(5),
    })
    expect(username.length).toBeLessThanOrEqual(20)
    expect(username).toMatch(HANDLE)
  })

  it('leaves a realistic share of handles without any number', () => {
    const random = seeded(13)
    let plain = 0
    const total = 800
    for (let index = 0; index < total; index++) {
      const username = generateUsername({
        firstName: 'Marie',
        lastName: 'Laurent',
        random,
      })
      if (!/\d/.test(username)) plain++
    }
    // The old generator always appended a number; people often do not.
    expect(plain / total).toBeGreaterThan(0.4)
  })

  it('rarely ends with a four digit number', () => {
    const random = seeded(17)
    let fourDigit = 0
    const total = 800
    for (let index = 0; index < total; index++) {
      const username = generateUsername({ firstName: 'Marco', lastName: 'Rossi', random })
      if (/\d{4}$/.test(username)) fourDigit++
    }
    expect(fourDigit / total).toBeLessThan(0.15)
  })

  it('uses separators often enough to look hand picked', () => {
    const random = seeded(19)
    let separated = 0
    const total = 800
    for (let index = 0; index < total; index++) {
      const username = generateUsername({
        firstName: 'Sofia',
        lastName: 'Ferrari',
        random,
      })
      if (/[._-]/.test(username)) separated++
    }
    const share = separated / total
    expect(share).toBeGreaterThan(0.25)
    expect(share).toBeLessThan(0.8)
  })

  it('never repeats a handle inside one batch', () => {
    const allocate = createUsernameAllocator(seeded(23))
    const seen = new Set<string>()
    for (let index = 0; index < 300; index++) {
      const username = allocate('Anna', 'Kowalska')
      expect(seen.has(username)).toBe(false)
      seen.add(username)
    }
  })

  it('falls back to a counter when every roll collides', () => {
    const allocate = createUsernameAllocator(() => 0)
    const seen = new Set<string>()
    for (let index = 0; index < 20; index++) {
      const username = allocate('Anna', 'Schmidt')
      expect(seen.has(username)).toBe(false)
      seen.add(username)
    }
  })

  it('respects names the caller already reserved', () => {
    const taken = new Set(['marie.laurent'])
    const random = seeded(29)
    for (let index = 0; index < 200; index++) {
      const username = generateUsername({
        firstName: 'Marie',
        lastName: 'Laurent',
        taken,
        random,
      })
      expect(username).not.toBe('marie.laurent')
    }
  })
})
