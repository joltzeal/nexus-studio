import { describe, expect, it } from 'vitest'
import { assertBinaryVersion, parseBrowserVersion } from './profile-runtime.js'

describe('persistent profile binary binding', () => {
  it('reads the exact build from Chromium output', () => {
    expect(parseBrowserVersion('CloakBrowser 146.0.7680.177.5')).toBe('146.0.7680.177.5')
  })

  it('rejects an updated binary for the same profile', () => {
    expect(() => assertBinaryVersion('155.0.1.1', '155.0.1.2')).toThrow(
      'PROFILE_ENGINE_MISMATCH',
    )
  })

  it('fails closed when the binary does not report a version', () => {
    expect(() => parseBrowserVersion('unknown')).toThrow('BINARY_VERSION_UNKNOWN')
  })
})
