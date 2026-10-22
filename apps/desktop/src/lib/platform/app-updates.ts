import { isTauri } from '@tauri-apps/api/core'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { listNativeProfiles } from './native-profiles'

export type AvailableUpdate = Update

export function updatesAvailable(): boolean {
  return isTauri() && import.meta.env.PROD
}

export async function checkAppUpdate(): Promise<AvailableUpdate | null> {
  return check()
}

export async function installAppUpdate(
  update: AvailableUpdate,
  onProgress: (downloaded: number, total: number | null) => void,
): Promise<void> {
  const windows = await listNativeProfiles()
  if (windows.some((window) => window.running)) {
    throw new Error('请先停止所有运行中的窗口，再安装更新。')
  }
  let downloaded = 0
  let total: number | null = null
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? null
      downloaded = 0
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
    }
    onProgress(downloaded, total)
  })
  await relaunch()
}
