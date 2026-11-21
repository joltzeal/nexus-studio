import { isTauri } from '@tauri-apps/api/core'
import { activateNativeRaccoon } from './raccoon/runtime'

async function start() {
  if (isTauri()) {
    activateNativeRaccoon()
    await import('./raccoon/main')
  } else {
    await import('./raccoon-preview/main')
  }
  document.documentElement.style.removeProperty('color-scheme')
}

void start()
