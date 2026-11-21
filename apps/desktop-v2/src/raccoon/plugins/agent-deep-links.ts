import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { navigateDetail, parseAgentDeepLink } from './detail-navigation'
import { toast } from '../../shared/model/toast'

export function startAgentDeepLinks() {
  if (!isTauri()) return () => {}
  let active = true
  let stop: (() => void) | undefined
  const open = (urls: unknown) => {
    if (!active || !Array.isArray(urls)) return
    for (const raw of urls) {
      if (typeof raw !== 'string') continue
      const request = parseAgentDeepLink(raw)
      if (request) navigateDetail(request)
    }
  }
  void listen<string[]>('deep-link://new-url', (event) => open(event.payload))
    .then(async (unlisten) => {
      if (!active) {
        unlisten()
        return
      }
      stop = unlisten
      try {
        open(await invoke<unknown>('plugin:deep-link|get_current'))
      } catch {
        if (active) toast.err('无法读取 Ecom Agent 启动链接，请从运行记录打开任务。')
      }
    })
    .catch(() => {
      if (active) toast.err('无法监听 Ecom Agent 任务链接，请从运行记录打开任务。')
    })
  return () => {
    if (!active) return
    active = false
    stop?.()
    stop = undefined
  }
}
