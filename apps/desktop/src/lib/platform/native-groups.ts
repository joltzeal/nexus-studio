import { invoke, isTauri } from '@tauri-apps/api/core'
import type { BrowserProviderId } from '@nexus/contracts/browser'

export interface WindowGroup {
  id: string
  providerId: BrowserProviderId
  name: string
  note: string
  windowCount: number
}

export function nativeGroupsAvailable(): boolean {
  return isTauri()
}

export function listGroups(providerId: BrowserProviderId): Promise<WindowGroup[]> {
  return invoke('group_list', { providerId })
}

export function createGroup(providerId: BrowserProviderId, name: string, note: string): Promise<WindowGroup> {
  return invoke('group_create', { providerId, name, note })
}

export function updateGroup(providerId: BrowserProviderId, id: string, name: string, note: string): Promise<void> {
  return invoke('group_update', { providerId, id, name, note })
}

export function deleteGroup(providerId: BrowserProviderId, id: string): Promise<void> {
  return invoke('group_delete', { providerId, id })
}
