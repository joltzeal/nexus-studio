import { invoke, isTauri } from '@tauri-apps/api/core'
import type { KernelSelection } from './native-kernels'

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

export function orderProfilesNewestFirst(
  profiles: readonly NativeProfile[],
): NativeProfile[] {
  // Equal seconds retain the host's persistent insertion order.
  return [...profiles].sort((left, right) => right.createdAt - left.createdAt)
}

export async function listNativeProfiles(): Promise<NativeProfile[]> {
  return orderProfilesNewestFirst(await invoke<NativeProfile[]>('profile_list'))
}

export function createNativeProfile(
  name: string,
  proxy: string | null,
  proxyPlugin: string | null,
  proxyEndpoint: number | null,
  settings: WindowSettings,
  kernel: KernelSelection = { kind: 'base' },
  groupId?: string | null,
): Promise<NativeProfile> {
  return invoke<NativeProfile>('profile_create', {
    name,
    proxy,
    proxyPlugin,
    proxyEndpoint,
    settings,
    kernelKind: kernel.kind,
    browserVersion: kernel.version ?? null,
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

export async function updateNativeProfileNote(
  id: string,
  input: string,
): Promise<string> {
  const note = input.trim()
  if (Array.from(note).length > 120) throw new Error('备注最多 120 个字符。')
  const saved = await invoke<unknown>('profile_update_note', { id, note })
  if (typeof saved !== 'string' || saved !== note) {
    throw new Error('备注保存结果未确认，请刷新窗口列表后重试。')
  }
  return saved
}

export function operateNativeProfile(id: string, running: boolean): Promise<void> {
  return invoke(running ? 'profile_stop' : 'profile_launch', { id })
}
