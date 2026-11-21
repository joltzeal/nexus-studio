import { create } from 'zustand'
import { isTauri } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'

export const APP_NAME = 'Raccoon'
export const APP_VERSION = '0.2.0'

export const useAppVersion = create<{ version: string }>(() => ({
  version: APP_VERSION,
}))

/** The bundled version wins outside the browser preview. */
export async function loadAppVersion() {
  if (!isTauri()) return
  try {
    useAppVersion.setState({ version: await getVersion() })
  } catch {}
}

const LAB_KEY = 'raccoon.lab-unlocked'

function readLabUnlocked() {
  try {
    return localStorage.getItem(LAB_KEY) === '1'
  } catch {
    return false
  }
}

type LabUnlock = {
  unlocked: boolean
  unlock: () => void
  /** Counts one version click; true when it completes the six-click run. */
  tap: () => boolean
}

let taps = 0
let timer: number | undefined

export const useLabUnlock = create<LabUnlock>((set, get) => ({
  unlocked: readLabUnlocked(),
  unlock: () => {
    taps = 0
    window.clearTimeout(timer)
    try {
      localStorage.setItem(LAB_KEY, '1')
    } catch {}
    set({ unlocked: true })
  },
  tap: () => {
    if (get().unlocked) return false
    taps += 1
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      taps = 0
    }, 1500)
    if (taps < 6) return false
    get().unlock()
    return true
  },
}))
