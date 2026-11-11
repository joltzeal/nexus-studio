import { z } from 'zod'

export const CONFIGURATION_METHODS = [
  'configuration.export',
  'configuration.validate',
  'configuration.import',
] as const

export const ConfigurationDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  data: z.unknown(),
})
export type ConfigurationDocument = z.infer<typeof ConfigurationDocumentSchema>

interface ConfigurationVault<T extends { ref: string }> {
  put(slot: string, plaintext: string): Promise<T>
  resolve(ref: string): Promise<string>
  drop(ref: string): Promise<void>
}

/** Keep old credentials usable until the plugin document has committed. */
export async function withConfigurationSecrets<T extends { ref: string }>(
  vault: ConfigurationVault<T>,
  apply: (staged: ConfigurationVault<T>) => Promise<void>,
): Promise<void> {
  const created = new Set<string>()
  const retired = new Set<string>()
  try {
    await apply({
      async put(slot, plaintext) {
        const result = await vault.put(slot, plaintext)
        created.add(result.ref)
        return result
      },
      resolve: (ref) => vault.resolve(ref),
      async drop(ref) {
        retired.add(ref)
      },
    })
  } catch (error) {
    await Promise.all([...created].map((ref) => vault.drop(ref).catch(() => {})))
    throw error
  }
  // Unreferenced values can be cleaned up later if the vault is temporarily unwritable.
  await Promise.all([...retired].map((ref) => vault.drop(ref).catch(() => {})))
}

export interface ConfigurationContext {
  method: string
  payload: unknown
  assertAlive(): void
}
export interface ConfigurationTransfer {
  call(
    context: ConfigurationContext,
  ): Promise<ConfigurationDocument | { valid: true } | { imported: true }>
}

/** Settings stay plugin-owned; the host only transports this versioned document. */
export function createConfigurationTransfer<T>(options: {
  schema: z.ZodType<T>
  read(): Promise<T>
  apply(data: T): Promise<void>
  invalid?: (message: string) => Error
}): ConfigurationTransfer {
  const invalid = options.invalid ?? ((message: string) => new Error(message))
  function parse(input: unknown): T {
    try {
      if (JSON.stringify(input).length > 128 * 1024)
        throw new Error('configuration too large')
      const document = ConfigurationDocumentSchema.safeParse(input)
      const data = options.schema.safeParse(document.success ? document.data.data : null)
      if (document.success && data.success) return data.data
    } catch {
      /* A plugin validator may throw while normalizing a field. */
    }
    throw invalid('插件配置格式或版本无效')
  }
  return {
    async call(
      context: ConfigurationContext,
    ): Promise<ConfigurationDocument | { valid: true } | { imported: true }> {
      context.assertAlive()
      switch (context.method) {
        case 'configuration.export': {
          if (!z.strictObject({}).safeParse(context.payload).success)
            throw invalid('导出配置参数无效')
          const data = await options.read()
          // Validate our own output with the same parser used for import.
          const validated = parse({ schemaVersion: 1, data })
          context.assertAlive()
          return { schemaVersion: 1, data: validated }
        }
        case 'configuration.validate':
          parse(context.payload)
          return { valid: true }
        case 'configuration.import': {
          const data = parse(context.payload)
          context.assertAlive()
          await options.apply(data)
          return { imported: true }
        }
        default:
          throw invalid('不支持的配置方法')
      }
    },
  }
}
