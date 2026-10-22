import { describe, expect, it } from 'vitest'
import {
  MAX_IMAGE_BYTES,
  MIN_IMAGE_EDGE,
  checkImageFile,
  toBase64,
} from './image-prepare'

describe('checkImageFile', () => {
  it('accepts the three formats the reference accepted', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(checkImageFile({ type, size: 1024 })).toBeNull()
    }
  })

  it('rejects anything the supplier cannot read', () => {
    expect(checkImageFile({ type: 'image/gif', size: 1024 })).toContain('JPEG')
    expect(checkImageFile({ type: '', size: 1024 })).toContain('JPEG')
  })

  it('rejects an empty or oversized file', () => {
    expect(checkImageFile({ type: 'image/jpeg', size: 0 })).toContain('为空')
    expect(checkImageFile({ type: 'image/jpeg', size: MAX_IMAGE_BYTES + 1 })).toContain(
      '5 MB',
    )
    expect(checkImageFile({ type: 'image/jpeg', size: MAX_IMAGE_BYTES })).toBeNull()
  })

  it('keeps the documented minimum edge', () => {
    expect(MIN_IMAGE_EDGE).toBe(100)
  })
})

describe('toBase64', () => {
  it('encodes a buffer the same way btoa would for small input', () => {
    const bytes = new TextEncoder().encode('nexus').buffer
    expect(toBase64(bytes)).toBe(btoa('nexus'))
  })

  it('handles input larger than one chunk', () => {
    const size = 100_000
    const buffer = new Uint8Array(size).fill(7).buffer
    const encoded = toBase64(buffer)
    expect(encoded).toHaveLength(Math.ceil(size / 3) * 4)
    expect(atob(encoded).length).toBe(size)
  })
})
