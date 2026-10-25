import { invoke, isTauri } from '@tauri-apps/api/core'

export interface LicenseStatus {
  configured: boolean
  plan: string | null
  expires: string | null
}

export function nativeLicenseAvailable(): boolean {
  return isTauri()
}

export function getLicenseStatus(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('license_status')
}

export function setLicenseKey(key: string): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('license_set', { key })
}

export function removeLicenseKey(): Promise<void> {
  return invoke('license_remove')
}
