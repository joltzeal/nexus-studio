import { useSyncExternalStore } from 'react'
import { BrowserProviderIdSchema, type BrowserProviderId } from '@nexus/contracts/browser'

const KEY = 'raccoon.space.v2'
const EVENT = 'raccoon:space-change'

function current(): BrowserProviderId {
  try {
    const selected = BrowserProviderIdSchema.safeParse(window.localStorage.getItem(KEY))
    return selected.success ? selected.data : 'adspower'
  } catch {
    return 'adspower'
  }
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}

export function useActiveBrowserSpace(): BrowserProviderId {
  return useSyncExternalStore(subscribe, current, () => 'adspower')
}

export function setActiveBrowserSpace(providerId: BrowserProviderId): void {
  window.localStorage.setItem(KEY, providerId)
  window.dispatchEvent(new Event(EVENT))
}
