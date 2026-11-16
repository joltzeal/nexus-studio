import { useSyncExternalStore } from 'react'

const KEY = 'raccoon.lab.aliasmode.enabled'
const EVENT = 'raccoon:lab-preferences'

export function aliasModeEnabled(): boolean {
  try {
    return window.localStorage.getItem(KEY) === 'true'
  } catch {
    return false
  }
}

export function setAliasModeEnabled(enabled: boolean): void {
  window.localStorage.setItem(KEY, String(enabled))
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}

export function useAliasModeEnabled(): boolean {
  return useSyncExternalStore(subscribe, aliasModeEnabled, () => false)
}
