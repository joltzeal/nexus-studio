import { invoke } from '@tauri-apps/api/core'
import {
  ConfigurationArchiveSchema,
  ConfigurationImportResultSchema,
  ConfigurationValidationResultSchema,
  PluginConfigurationDocumentSchema,
  type ConfigurationArchive,
} from '@nexus/contracts/configuration'
import { pluginApi } from './api'
import { callPlugin } from './call'
import type { PluginView } from './types'

export type { ConfigurationArchive } from '@nexus/contracts/configuration'

const MAX_BYTES = 8 * 1024 * 1024
const METHODS = ['configuration.export', 'configuration.validate', 'configuration.import']
type CurrentSession = () => boolean

export interface ConfigurationTarget {
  id: string
  name: string
  version: string
  available: boolean
  reason: string | null
  capability: string | undefined
  installation: string | undefined
  runtimeGeneration: string | null | undefined
}

export interface ConfigurationResult {
  id: string
  name: string
  success: boolean
  error?: string
}

export function configurationError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : cause
  return typeof message === 'string' && message.length > 0 && message.length <= 4096
    ? message
    : '插件配置操作失败，请重试'
}

export function pluginConfigurationTargets(plugins: PluginView[]): ConfigurationTarget[] {
  return plugins
    .filter((plugin) => plugin.state !== 'available')
    .map((plugin) => {
      const capability = plugin.capabilities.find((value) =>
        plugin.granted.includes(value),
      )
      const reason =
        plugin.state === 'unlicensed'
          ? '需要激活插件'
          : !plugin.enabled
            ? '插件未启用'
            : plugin.state !== 'running'
              ? '插件尚未运行'
              : !capability
                ? '插件能力未授权'
                : !METHODS.every((method) => plugin.methods.includes(method))
                  ? '暂不支持配置迁移'
                  : !plugin.installation || !plugin.runtimeGeneration
                    ? '无法确认插件运行实例，请刷新'
                    : null
      return {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        capability,
        available: reason === null,
        reason,
        installation: plugin.installation,
        runtimeGeneration: plugin.runtimeGeneration,
      }
    })
}

function current(check: CurrentSession) {
  if (!check()) throw new Error('配置操作已结束，请重新打开')
}

function selection(ids: string[], known: readonly { id: string }[]) {
  if (!ids.length || ids.length > 64 || new Set(ids).size !== ids.length)
    throw new Error('请选择 1 至 64 个不同的插件')
  if (ids.some((id) => !known.some((entry) => entry.id === id)))
    throw new Error('所选插件不在当前配置列表中，请重新选择')
}

function availableTargets(ids: string[], targets: ConfigurationTarget[]) {
  return ids.map((id) => {
    const target = targets.find((entry) => entry.id === id)
    if (!target?.available)
      throw new Error(`${target?.name ?? id}：${target?.reason ?? '插件未安装'}`)
    return target
  })
}

function sameTarget(expected: ConfigurationTarget, targets: ConfigurationTarget[]) {
  const target = targets.find((entry) => entry.id === expected.id)
  if (
    !target?.available ||
    target.version !== expected.version ||
    target.installation !== expected.installation ||
    target.runtimeGeneration !== expected.runtimeGeneration ||
    target.capability !== expected.capability
  )
    throw new Error('插件状态已变化，请刷新并重新核对配置')
}

async function catalog(check: CurrentSession) {
  current(check)
  const targets = pluginConfigurationTargets(await pluginApi.list())
  current(check)
  return targets
}

async function freshTarget(target: ConfigurationTarget, check: CurrentSession) {
  sameTarget(target, await catalog(check))
}

function serialize(archive: ConfigurationArchive) {
  const parsed = ConfigurationArchiveSchema.safeParse(archive)
  if (!parsed.success) throw new Error('配置文件无效或版本不受支持')
  const content = JSON.stringify(parsed.data, null, 2) + '\n'
  if (new TextEncoder().encode(content).byteLength > MAX_BYTES)
    throw new Error('配置文件超过 8 MB，请分批导出')
  return content
}

export function parsePluginConfiguration(content: string): ConfigurationArchive {
  if (new TextEncoder().encode(content).byteLength > MAX_BYTES)
    throw new Error('配置文件超过 8 MB')
  try {
    return ConfigurationArchiveSchema.parse(JSON.parse(content))
  } catch {
    throw new Error('配置文件无效或版本不受支持，请选择当前版本导出的 JSON 文件')
  }
}

export async function exportPluginConfiguration(
  ids: string[],
  check: CurrentSession = () => true,
): Promise<ConfigurationArchive> {
  const targets = await catalog(check)
  selection(ids, targets)
  const selected = availableTargets(ids, targets)
  const plugins: ConfigurationArchive['plugins'] = []
  for (const target of selected) {
    await freshTarget(target, check)
    current(check)
    const result = await callPlugin(
      target.id,
      target.capability!,
      'configuration.export',
      {},
      (value) => value,
      30_000,
      `${target.installation}:${target.runtimeGeneration}`,
    )
    current(check)
    const configuration = PluginConfigurationDocumentSchema.safeParse(result)
    if (!configuration.success) throw new Error(`${target.name}：插件返回的配置格式无效`)
    plugins.push({
      id: target.id,
      name: target.name,
      version: target.version,
      configuration: configuration.data,
    })
  }
  const latest = await catalog(check)
  for (const target of selected) sameTarget(target, latest)
  const archive: ConfigurationArchive = {
    format: 'raccoon-configuration',
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    preferences: null,
    networkProxy: null,
    plugins,
  }
  serialize(archive)
  return archive
}

export async function importPluginConfiguration(
  archive: ConfigurationArchive,
  ids: string[],
  check: CurrentSession = () => true,
): Promise<ConfigurationResult[]> {
  const parsed = parsePluginConfiguration(JSON.stringify(archive))
  selection(ids, parsed.plugins)
  const targets = availableTargets(ids, await catalog(check))
  const selected = ids.map((id) => parsed.plugins.find((plugin) => plugin.id === id)!)
  for (const plugin of selected) {
    const target = targets.find((entry) => entry.id === plugin.id)!
    await freshTarget(target, check)
    current(check)
    try {
      await callPlugin(
        plugin.id,
        target.capability!,
        'configuration.validate',
        plugin.configuration,
        (value) => {
          if (!ConfigurationValidationResultSchema.safeParse(value).success)
            throw new Error('插件未确认配置校验通过')
        },
        30_000,
        `${target.installation}:${target.runtimeGeneration}`,
      )
    } catch (cause) {
      throw new Error(`${plugin.name}：${configurationError(cause)}`)
    }
    current(check)
  }
  const results: ConfigurationResult[] = []
  for (const plugin of selected) {
    current(check)
    const target = targets.find((entry) => entry.id === plugin.id)!
    try {
      await freshTarget(target, check)
      current(check)
      await callPlugin(
        plugin.id,
        target.capability!,
        'configuration.import',
        plugin.configuration,
        (value) => {
          if (!ConfigurationImportResultSchema.safeParse(value).success)
            throw new Error('插件未确认配置写入成功')
        },
        30_000,
        `${target.installation}:${target.runtimeGeneration}`,
      )
      results.push({ id: plugin.id, name: plugin.name, success: true })
    } catch (cause) {
      results.push({
        id: plugin.id,
        name: plugin.name,
        success: false,
        error: configurationError(cause),
      })
    }
  }
  current(check)
  return results
}

export async function savePluginConfigurationFile(
  archive: ConfigurationArchive,
): Promise<string | null> {
  const path = await invoke<unknown>('configuration_file_export', {
    content: serialize(archive),
  })
  if (path !== null && (typeof path !== 'string' || !path.trim()))
    throw new Error('配置文件保存结果无效')
  return path as string | null
}

export async function openPluginConfigurationFile(): Promise<{
  name: string
  archive: ConfigurationArchive
} | null> {
  const value = await invoke<unknown>('configuration_file_import')
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('配置文件读取结果无效')
  const file = value as Record<string, unknown>
  if (
    typeof file.name !== 'string' ||
    !file.name.trim() ||
    typeof file.content !== 'string'
  )
    throw new Error('配置文件读取结果无效')
  return { name: file.name, archive: parsePluginConfiguration(file.content) }
}
