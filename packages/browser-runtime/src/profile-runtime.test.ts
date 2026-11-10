import { describe, expect, it } from 'vitest'
import { assertBinaryVersion, parseBrowserVersion } from './profile-runtime.js'

describe('persistent profile binary binding', () => {
  it('reads the exact build from Chromium output', () => {
    expect(parseBrowserVersion('CloakBrowser 155.0.8059.39.5')).toBe('155.0.8059.39.5')
  })

  it('checks a Chromium display version without changing the full package binding', () => {
    expect(() => assertBinaryVersion('155.0.8059.39.5', '155.0.8059.39')).not.toThrow()
    expect(() => assertBinaryVersion('155.0.8059.39.5', '155.0.8059.39.4')).toThrow(
      'PROFILE_ENGINE_MISMATCH',
    )
  })

  it('rejects an updated binary for the same profile', () => {
    expect(() => assertBinaryVersion('155.0.1.1', '155.0.1.2')).toThrow(
      'PROFILE_ENGINE_MISMATCH',
    )
  })

  it('fails closed when the binary does not report a version', () => {
    expect(() => parseBrowserVersion('unknown')).toThrow('BINARY_VERSION_UNKNOWN')
  })

  it('rejects an unsupported dotted version instead of extracting a shorter prefix', () => {
    expect(() => parseBrowserVersion('Chromium 155.0.8059.39.2.3')).toThrow(
      'BINARY_VERSION_UNKNOWN',
    )
  })
})
