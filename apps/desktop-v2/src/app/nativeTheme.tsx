import { useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useTheme } from '@proxyshard/shardx-ui-kit'

/// The native window (its background while resizing, native menus, file
/// dialogs) follows the app's theme, not only the system's (WIG-11).
export function NativeThemeSync() {
  const { theme, previewTheme, resolvedTheme } = useTheme()
  const nativeTheme = (previewTheme ?? theme) === 'system' ? null : resolvedTheme
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    getCurrentWindow()
      .setTheme(nativeTheme)
      .catch(() => {})
  }, [nativeTheme])
  return null
}
