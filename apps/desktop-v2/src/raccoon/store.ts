import { useSyncExternalStore } from 'react'
import { nativeApi } from './api'
import { NativeWorkspace } from './controller'
import {
  closeProfileForm,
  openProfileForm,
} from '../features/profile-form/model/useProfileForm'

export const workspace = new NativeWorkspace(nativeApi)
export const useWorkspace = () =>
  useSyncExternalStore(workspace.subscribe, workspace.snapshot)

export function openNativeEditor(id: string | null) {
  const provider = workspace.state.connections.find(
    (row) => row.id === workspace.state.connectionId,
  )?.providerId
  if (!provider) return
  openProfileForm(id ? { mode: 'edit', id } : { mode: 'create' })
}
export const closeNativeEditor = () => closeProfileForm()
