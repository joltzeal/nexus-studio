import { isTauri } from '@tauri-apps/api/core'
import {
  navigateDetail,
  parseAgentDeepLink,
  type DetailNavigation,
} from '../detail-navigation'

interface DeepLinkClient {
  getCurrent: () => Promise<string[] | null>
  onOpenUrl: (listener: (urls: string[]) => void) => Promise<() => void>
  navigate: (request: DetailNavigation) => void
}

export async function connectAgentDeepLinks(client: DeepLinkClient): Promise<() => void> {
  let active = true
  const open = (urls: string[]) => {
    if (!active) return
    for (const raw of urls) {
      const request = parseAgentDeepLink(raw)
      if (request) client.navigate(request)
    }
  }
  const unlisten = await client.onOpenUrl(open)
  try {
    open((await client.getCurrent()) ?? [])
  } catch (error) {
    active = false
    unlisten()
    throw error
  }
  return () => {
    active = false
    unlisten()
  }
}

export function startAgentDeepLinks(): () => void {
  if (!isTauri()) return () => {}
  let active = true
  let stop: (() => void) | undefined
  void import('@tauri-apps/plugin-deep-link')
    .then(async (client) => {
      const cleanup = await connectAgentDeepLinks({ ...client, navigate: navigateDetail })
      if (!active) cleanup()
      else stop = cleanup
    })
    .catch(() => {
      // Navigation links are optional; task execution and recovery use native storage.
    })
  return () => {
    active = false
    stop?.()
  }
}
