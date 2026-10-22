import { describe, expect, it } from 'vitest'
import { randomFingerprintSeed, randomWindowName } from './random-name'

describe('window naming', () => {
  it('names an unnamed window with one English word', () => {
    const name = randomWindowName()
    expect(name).toMatch(/^[a-z]+$/)
    expect(name.length).toBeGreaterThan(2)
  })

  it('never reuses a name that is already taken', () => {
    const first = randomWindowName()
    const second = randomWindowName([first])
    expect(second).not.toBe(first)
    expect(second).toMatch(/^[a-z]+(-\d+)?$/)
  })

  it('keeps the seed inside the range the host accepts', () => {
    for (let index = 0; index < 50; index += 1) {
      const seed = randomFingerprintSeed()
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(1)
      expect(seed).toBeLessThanOrEqual(2_147_483_647)
    }
  })
})
