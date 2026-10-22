import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import {
  DEFAULT_PREFERENCES,
  PreferencesSchema,
  type Preferences,
} from '@nexus/contracts'
import { PreferencesContext, type SaveStatus } from './preferences-context'
import {
  createPreferenceWriter,
  getPreferenceRepository,
  preferenceErrorMessage,
} from '@/lib/platform/preferences'

export function PreferencesProvider({ children }: PropsWithChildren) {
  const [preferences, setPreferences] = useState<Preferences>({ ...DEFAULT_PREFERENCES })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const [systemReducedMotion, setSystemReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const latest = useRef(preferences)
  const revision = useRef(0)
  const writer = useRef<ReturnType<typeof createPreferenceWriter> | null>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const repository = getPreferenceRepository()
        const saved = await repository.load()
        if (!active) return
        latest.current = saved
        writer.current = createPreferenceWriter(repository)
        setPreferences(saved)
        setLoadError(null)
      } catch (error) {
        if (active) setLoadError(preferenceErrorMessage(error))
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [loadAttempt])

  useEffect(() => {
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)')
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updateColor = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    const updateMotion = (event: MediaQueryListEvent) =>
      setSystemReducedMotion(event.matches)
    colorScheme.addEventListener('change', updateColor)
    motion.addEventListener('change', updateMotion)
    return () => {
      colorScheme.removeEventListener('change', updateColor)
      motion.removeEventListener('change', updateMotion)
    }
  }, [])

  const resolvedTheme =
    preferences.theme === 'system' ? (systemDark ? 'dark' : 'light') : preferences.theme

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', resolvedTheme === 'dark')
    root.dataset.accent = preferences.accent
    root.dataset.density = preferences.density
    root.dataset.motion =
      preferences.reducedMotion || systemReducedMotion ? 'reduced' : 'full'
    root.style.colorScheme = resolvedTheme
  }, [
    preferences.accent,
    preferences.density,
    preferences.reducedMotion,
    resolvedTheme,
    systemReducedMotion,
  ])

  const persist = useCallback(async (next: Preferences) => {
    if (!writer.current) return false
    const currentRevision = ++revision.current
    setSaveStatus('saving')
    setSaveError(null)
    try {
      const saved = await writer.current(next)
      if (currentRevision === revision.current) {
        latest.current = saved
        setPreferences(saved)
        setSaveStatus('saved')
      }
      return true
    } catch (error) {
      if (currentRevision === revision.current) {
        setSaveStatus('error')
        setSaveError(preferenceErrorMessage(error))
      }
      return false
    }
  }, [])

  const update = useCallback(
    async (patch: Partial<Omit<Preferences, 'schemaVersion'>>) => {
      const parsed = PreferencesSchema.safeParse({ ...latest.current, ...patch })
      if (!parsed.success || !writer.current) return false
      latest.current = parsed.data
      setPreferences(parsed.data)
      return persist(parsed.data)
    },
    [persist],
  )

  const reload = useCallback(() => {
    setLoading(true)
    setLoadAttempt((attempt) => attempt + 1)
  }, [])

  const retrySave = useCallback(() => persist(latest.current), [persist])

  const value = useMemo(
    () => ({
      preferences,
      loading,
      loadError,
      saveError,
      saveStatus,
      resolvedTheme,
      update,
      reload,
      retrySave,
    }),
    [
      preferences,
      loading,
      loadError,
      saveError,
      saveStatus,
      resolvedTheme,
      update,
      reload,
      retrySave,
    ],
  )

  return (
    <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
  )
}
