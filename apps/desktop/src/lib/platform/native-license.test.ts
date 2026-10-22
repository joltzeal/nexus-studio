import { describe, expect, it } from 'vitest'
import { canPinBrowserVersion, type LicenseStatus } from './native-license'

const status = (values: Partial<LicenseStatus>): LicenseStatus => ({
  configured: false,
  plan: null,
  expires: null,
  ...values,
})

describe('browser version pin entitlement', () => {
  it('allows version selection only for a configured non-free plan', () => {
    expect(canPinBrowserVersion(status({ configured: true, plan: 'team' }))).toBe(true)
    expect(canPinBrowserVersion(status({ configured: true, plan: 'Pro' }))).toBe(true)
    expect(canPinBrowserVersion(status({ configured: true, plan: 'free' }))).toBe(false)
    expect(canPinBrowserVersion(status({ configured: false, plan: 'team' }))).toBe(false)
    expect(canPinBrowserVersion(status({ configured: true, plan: null }))).toBe(false)
  })
})
