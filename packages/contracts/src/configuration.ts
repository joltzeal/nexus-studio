import { z } from 'zod'
import { PreferencesSchema } from './preferences.js'

export const ConfigurationValidationResultSchema = z.strictObject({
  valid: z.literal(true),
})
export const ConfigurationImportResultSchema = z.strictObject({
  imported: z.literal(true),
})

export const PluginConfigurationDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    data: z.unknown(),
  })
  .refine((document) => JSON.stringify(document).length <= 128 * 1024)
const networkProxySchema = z
  .strictObject({
    mode: z.enum(['direct', 'system', 'manual']),
    url: z.string().max(2048).nullable(),
  })
  .refine((value) => {
    if (value.mode !== 'manual') return value.url === null
    const text = value.url ?? ''
    if (!z.url({ protocol: /^(?:https?|socks5)$/ }).safeParse(text).success) return false
    const match =
      /^(https?|socks5):\/\/(?:\[[a-f\d:.]+\]|[a-z\d.-]+):(\d{1,5})\/?$/i.exec(text)
    if (!match) return false
    const port = Number(match[2])
    return (
      port > 0 &&
      port <= 65535 &&
      !(match[1] === 'http' && port === 80) &&
      !(match[1] === 'https' && port === 443)
    )
  })
export const ConfigurationArchiveSchema = z
  .strictObject({
    format: z.literal('nexus-configuration'),
    schemaVersion: z.literal(1),
    exportedAt: z.iso.datetime(),
    preferences: PreferencesSchema.nullable(),
    networkProxy: networkProxySchema.nullable(),
    plugins: z
      .array(
        z.strictObject({
          id: z
            .string()
            .max(253)
            .regex(/^[a-z][a-z0-9.-]*\.[a-z][a-z0-9.-]*$/),
          name: z.string().min(1).max(80),
          version: z.string().min(1).max(80),
          configuration: PluginConfigurationDocumentSchema,
        }),
      )
      .max(64),
  })
  .refine(
    (value) =>
      new Set(value.plugins.map((plugin) => plugin.id)).size === value.plugins.length,
  )
export type ConfigurationArchive = z.infer<typeof ConfigurationArchiveSchema>
export type PluginConfigurationDocument = z.infer<
  typeof PluginConfigurationDocumentSchema
>
