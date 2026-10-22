import { invoke, isTauri } from '@tauri-apps/api/core'

export interface NativeProfile {
  id: string
  name: string
  version: string
  proxy: string | null
  proxyPlugin: string | null
  /** One row of the proxy plugin's inventory; null follows its default. */
  proxyEndpoint: number | null
  running: boolean
  groupId: string | null
  settings: WindowSettings
  /** Unix seconds; 0 for records written before the field existed. */
  createdAt: number
  /** Unix seconds of the last successful launch, or null when never opened. */
  lastOpenedAt: number | null
}

export interface WindowSettings {
  platform: 'Vinted' | 'Poshmark' | '其他'
  note: string
  geoip: boolean
  timezone: string
  locale: string
  viewport: 'default' | '1440x900' | '1920x1080'
  fingerprintSeed: number | null
  startUrl: string
}

export function nativeProfilesAvailable(): boolean {
  return isTauri()
}

export function listNativeProfiles(): Promise<NativeProfile[]> {
  return invoke<NativeProfile[]>('profile_list')
}

export function createNativeProfile(
  name: string,
  proxy: string | null,
  proxyPlugin: string | null,
  proxyEndpoint: number | null,
  settings: WindowSettings,
  browserVersion?: string,
  groupId?: string | null,
): Promise<NativeProfile> {
  return invoke<NativeProfile>('profile_create', {
    name,
    proxy,
    proxyPlugin,
    proxyEndpoint,
    settings,
    browserVersion: browserVersion ?? null,
    groupId: groupId ?? null,
  })
}

export function updateNativeProfile(
  id: string,
  name: string,
  proxy: string | null,
  proxyPlugin: string | null,
  proxyEndpoint: number | null,
  settings: WindowSettings,
  groupId?: string | null,
): Promise<void> {
  return invoke('profile_update', {
    id,
    name,
    proxy,
    proxyPlugin,
    proxyEndpoint,
    settings,
    groupId: groupId ?? null,
  })
}

export function deleteNativeProfile(id: string): Promise<void> {
  return invoke('profile_delete', { id })
}

export function operateNativeProfile(id: string, running: boolean): Promise<void> {
  return invoke(running ? 'profile_stop' : 'profile_launch', { id })
}
