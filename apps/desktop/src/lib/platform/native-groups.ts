import { invoke, isTauri } from '@tauri-apps/api/core'

export interface WindowGroup {
  id: string
  name: string
  note: string
  windowCount: number
}

export function nativeGroupsAvailable(): boolean {
  return isTauri()
}

export function listGroups(): Promise<WindowGroup[]> {
  return invoke('group_list')
}

export function createGroup(name: string, note: string): Promise<WindowGroup> {
  return invoke('group_create', { name, note })
}

export function updateGroup(id: string, name: string, note: string): Promise<void> {
  return invoke('group_update', { id, name, note })
}

export function deleteGroup(id: string): Promise<void> {
  return invoke('group_delete', { id })
}
