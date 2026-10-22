import { createContext } from 'react'
import type { Preferences } from '@nexus/contracts'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface PreferencesContextValue {
  preferences: Preferences
  loading: boolean
  loadError: string | null
  saveError: string | null
  saveStatus: SaveStatus
  resolvedTheme: 'light' | 'dark'
  update: (patch: Partial<Omit<Preferences, 'schemaVersion'>>) => Promise<boolean>
  reload: () => void
  retrySave: () => Promise<boolean>
}

export const PreferencesContext = createContext<PreferencesContextValue | null>(null)
