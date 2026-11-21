import { describe, expect, it, vi } from 'vitest'
import { ImageOwners } from './image-owners'

describe('shared image resource lifetime', () => {
  it('keeps a shared image while the row or detail still owns it', () => {
    const release = vi.fn()
    const owners = new ImageOwners(release)
    const row = owners.retain('image')
    const detail = owners.retain('image')
    row()
    expect(release).not.toHaveBeenCalled()
    detail()
    expect(release).toHaveBeenCalledExactlyOnceWith('image')
  })
  it('releases different files independently and allows a later session', () => {
    const release = vi.fn()
    const owners = new ImageOwners(release)
    const first = owners.retain('first')
    const second = owners.retain('second')
    first()
    first()
    expect(release.mock.calls).toEqual([['first']])
    const later = owners.retain('first')
    second()
    later()
    expect(release.mock.calls).toEqual([['first'], ['second'], ['first']])
  })
})
