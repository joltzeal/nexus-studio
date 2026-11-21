import { invoke } from '@tauri-apps/api/core'
import { useSyncExternalStore } from 'react'
import { PluginUiSession } from './ui-session'
import { pluginUiRuntime } from './ui-runtime'

export const pluginUi = new PluginUiSession(
  (input) => invoke('plugin_ui_command', { input }),
  pluginUiRuntime.observe,
)
export const usePluginUi = () =>
  useSyncExternalStore(pluginUi.subscribe, pluginUi.snapshot)
