import { invoke } from '@tauri-apps/api/core'
import { useEffect, useSyncExternalStore, type RefObject } from 'react'
import {
  PluginUiProfileStatusController,
  type PluginUiProfileTarget,
} from './ui-profile-status'

export const pluginProfileStatus = new PluginUiProfileStatusController({
  rpc: (input) => invoke('plugin_ui_profiles', { input }),
})

export function usePluginProfileStatus(
  target: PluginUiProfileTarget,
  profileId: string,
  enabled: boolean,
  ref: RefObject<HTMLElement | null>,
) {
  const { pluginId, viewId, connectionId, identity } = target
  useEffect(() => {
    if (!enabled || !ref.current) return
    const scope = { pluginId, viewId, connectionId, identity }
    if (typeof IntersectionObserver === 'undefined')
      return pluginProfileStatus.watch(scope, profileId)
    let stop: (() => void) | undefined
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) stop ??= pluginProfileStatus.watch(scope, profileId)
      else {
        stop?.()
        stop = undefined
      }
    })
    observer.observe(ref.current)
    return () => {
      observer.disconnect()
      stop?.()
    }
  }, [pluginId, viewId, connectionId, identity, profileId, enabled, ref])
  return useSyncExternalStore(pluginProfileStatus.subscribe, () =>
    pluginProfileStatus.snapshot(target, profileId),
  )
}
