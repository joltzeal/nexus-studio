import { invoke } from '@tauri-apps/api/core'
import type { PluginUiNotice, PluginUiView } from '@nexus/plugin-sdk/ui'
import { useToastStore, toast } from '../../shared/model/toast'
import { clip } from '../../shared/lib/clipboard'
import { usePluginCatalog } from './catalog'
import type { PluginUiTarget } from './ui-session'
import { PluginUiTaskController } from './ui-task-runtime'
import { VerificationSound } from './verification-sound'
import { pluginProfileStatus } from './ui-profile-store'

const sound = new VerificationSound()
let tasks: PluginUiTaskController | null = null

function showNotice(
  target: PluginUiTarget,
  notice: PluginUiNotice,
  current: () => boolean,
) {
  let id = 0
  const copy = () => {
    void clip
      .write(notice.copyText!)
      .then(() => {
        useToastStore.getState().update(id, { action: { label: '已复制', run: copy } })
      })
      .catch(() => toast.fail({ title: '复制失败，请重试' }))
    return false
  }
  id = useToastStore.getState().push(
    {
      kind: notice.tone === 'error' ? 'err' : notice.tone === 'warning' ? 'warn' : 'ok',
      title: notice.title,
      detail: notice.message,
      persistent: true,
      dedupeKey: JSON.stringify([target.pluginId, target.identity, notice.id]),
      action: notice.copyText ? { label: '复制', run: copy } : undefined,
    },
    null,
  )
  if (notice.tone === 'success' && notice.speech) {
    const failed = () => {
      if (current()) toast.warn({ title: '验证码语音播放失败，可复制通知中的验证码' })
    }
    void sound
      .play(notice.speech.channel, notice.speech.code)
      .then((played) => {
        if (!played) failed()
      })
      .catch(failed)
  }
}

export const pluginUiRuntime = {
  // Call directly in the click event, before any confirmation or RPC await.
  arm: () => {
    void sound.arm()
  },
  observe: (target: PluginUiTarget, view: PluginUiView) => tasks?.observe(target, view),
  cancel: (target: PluginUiTarget, ids: readonly string[]) => tasks?.cancel(target, ids),
}

export function startPluginUiRuntime() {
  const controller = new PluginUiTaskController({
    rpc: (input) => invoke('plugin_ui_task_command', { input }),
    notice: (target, notice) => showNotice(target, notice, () => tasks === controller),
    error: (message) => {
      toast.fail({ title: message })
    },
  })
  tasks = controller
  const catalog = () => {
    const state = usePluginCatalog.getState()
    controller.setCatalog(state.plugins)
    pluginProfileStatus.setCatalog(state.plugins, !state.error)
  }
  catalog()
  const unsubscribe = usePluginCatalog.subscribe(catalog)
  return () => {
    unsubscribe()
    controller.dispose()
    if (tasks === controller) tasks = null
    pluginProfileStatus.dispose()
    sound.close()
  }
}
