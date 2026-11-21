import { z } from 'zod'

export const ThemeModeSchema = z.enum(['light', 'dark', 'system'])
export const AccentColorSchema = z.enum(['cobalt', 'coral', 'graphite', 'iris'])
export const InterfaceDensitySchema = z.enum(['comfortable', 'compact'])

export const PreferencesSchema = z.strictObject({
  schemaVersion: z.literal(2),
  theme: ThemeModeSchema,
  accent: AccentColorSchema,
  density: InterfaceDensitySchema,
  reducedMotion: z.boolean(),
})

export type ThemeMode = z.infer<typeof ThemeModeSchema>
export type AccentColor = z.infer<typeof AccentColorSchema>
export type InterfaceDensity = z.infer<typeof InterfaceDensitySchema>
export type Preferences = z.infer<typeof PreferencesSchema>

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  schemaVersion: 2,
  theme: 'light',
  accent: 'cobalt',
  density: 'comfortable',
  reducedMotion: false,
})

export function parsePreferences(input: unknown): Preferences {
  return PreferencesSchema.parse(input)
}
