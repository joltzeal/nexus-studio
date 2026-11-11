import { invoke } from '@tauri-apps/api/core'
import type { Preferences } from '@nexus/contracts'
import {
  ConfigurationArchiveSchema,
  ConfigurationImportResultSchema,
  ConfigurationValidationResultSchema,
  PluginConfigurationDocumentSchema,
  type ConfigurationArchive,
  type PluginConfigurationDocument as PluginDocument,
} from '@nexus/contracts/configuration'
export { ConfigurationArchiveSchema } from '@nexus/contracts/configuration'
export type { ConfigurationArchive } from '@nexus/contracts/configuration'
import { callPlugin, type PluginView } from './native-plugins'
import type { NetworkProxy } from './native-network-proxy'

export const CONFIGURATION_MAX_BYTES = 8 * 1024 * 1024
const methods = ['configuration.export', 'configuration.validate', 'configuration.import']
export interface ConfigurationTarget {
  id: string
  name: string
  version: string
  available: boolean
  read(): Promise<unknown>
  validate(document: PluginDocument): Promise<unknown>
  write(document: PluginDocument): Promise<unknown>
}
export interface ConfigurationImportResult {
  id: string
  name: string
  success: boolean
  error?: string
}
export function configurationError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return '配置读写失败，请重试。'
}
export function pluginConfigurationTargets(plugins: PluginView[]): ConfigurationTarget[] {
  return plugins
    .filter((plugin) => plugin.enabled)
    .map((plugin) => {
      const capability = plugin.capabilities.find((entry) =>
        plugin.granted.includes(entry),
      )
      const available =
        plugin.state === 'running' &&
        !!capability &&
        methods.every((method) => plugin.methods.includes(method))
      const call = (method: string, payload: unknown = {}) => {
        if (!available || !capability)
          return Promise.reject(new Error('插件未安装或暂不可用'))
        return callPlugin(plugin.id, capability, method, payload)
      }
      return {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        available,
        read: () => call('configuration.export'),
        validate: async (payload) => {
          const result = await call('configuration.validate', payload)
          if (!ConfigurationValidationResultSchema.safeParse(result).success)
            throw new Error('插件未确认配置校验通过')
        },
        write: async (payload) => {
          const result = await call('configuration.import', payload)
          if (!ConfigurationImportResultSchema.safeParse(result).success)
            throw new Error('插件未确认配置写入成功')
        },
      }
    })
}

export async function exportConfiguration(
  targets: ConfigurationTarget[],
  settings: { preferences: Preferences | null; networkProxy: NetworkProxy | null },
) {
  const plugins: ConfigurationArchive['plugins'] = []
  const skipped: string[] = []
  for (const target of targets) {
    if (!target.available) {
      skipped.push(target.name)
      continue
    }
    const configuration = PluginConfigurationDocumentSchema.parse(await target.read())
    plugins.push({
      id: target.id,
      name: target.name,
      version: target.version,
      configuration,
    })
  }
  const archive = ConfigurationArchiveSchema.parse({
    format: 'nexus-configuration',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    ...settings,
    plugins,
  })
  serializeConfiguration(archive)
  return { archive, skipped }
}
export function serializeConfiguration(archive: ConfigurationArchive): string {
  const content =
    JSON.stringify(ConfigurationArchiveSchema.parse(archive), null, 2) + '\n'
  if (new TextEncoder().encode(content).byteLength > CONFIGURATION_MAX_BYTES)
    throw new Error('配置文件超过 8 MB，请减少导出的配置。')
  return content
}
export function parseConfiguration(content: string): ConfigurationArchive {
  if (new TextEncoder().encode(content).byteLength > CONFIGURATION_MAX_BYTES)
    throw new Error('配置文件超过 8 MB。')
  try {
    return ConfigurationArchiveSchema.parse(JSON.parse(content))
  } catch {
    throw new Error('配置文件无效或版本不受支持，请选择 Nexus 导出的 JSON 文件。')
  }
}

export async function importConfiguration(options: {
  archive: ConfigurationArchive
  targets: ConfigurationTarget[]
  selected: string[]
  writePreferences(value: Preferences): Promise<unknown>
  writeNetworkProxy(value: NetworkProxy): Promise<unknown>
}): Promise<ConfigurationImportResult[]> {
  const archive = ConfigurationArchiveSchema.parse(options.archive)
  const selected = new Set(options.selected)
  const operations: { id: string; name: string; write: () => Promise<unknown> }[] = []
  for (const plugin of archive.plugins) {
    if (!selected.has(plugin.id)) continue
    const target = options.targets.find(
      (entry) => entry.id === plugin.id && entry.available,
    )
    if (!target) throw new Error(`${plugin.name}：插件未安装或暂不可用`)
    try {
      await target.validate(plugin.configuration)
    } catch (error) {
      throw Object.assign(new Error(`${plugin.name}：${configurationError(error)}`), {
        cause: error,
      })
    }
    operations.push({
      id: plugin.id,
      name: plugin.name,
      write: () => target.write(plugin.configuration),
    })
  }
  const preferences = archive.preferences
  if (selected.has('preferences') && preferences !== null)
    operations.push({
      id: 'preferences',
      name: '外观与工作区',
      write: () => options.writePreferences(preferences),
    })
  // Changing the application route restarts plugin processes, so apply it last.
  const network = archive.networkProxy
  if (selected.has('networkProxy') && network !== null)
    operations.push({
      id: 'networkProxy',
      name: '应用代理',
      write: () => options.writeNetworkProxy(network),
    })
  const results: ConfigurationImportResult[] = []
  for (const operation of operations) {
    try {
      await operation.write()
      results.push({ id: operation.id, name: operation.name, success: true })
    } catch (error) {
      results.push({
        id: operation.id,
        name: operation.name,
        success: false,
        error: configurationError(error),
      })
    }
  }
  return results
}

export function saveConfigurationFile(archive: ConfigurationArchive) {
  return invoke<string | null>('configuration_file_export', {
    content: serializeConfiguration(archive),
  })
}
export async function openConfigurationFile() {
  const file = await invoke<{ name: string; content: string } | null>(
    'configuration_file_import',
  )
  return file === null
    ? null
    : { name: file.name, archive: parseConfiguration(file.content) }
}
