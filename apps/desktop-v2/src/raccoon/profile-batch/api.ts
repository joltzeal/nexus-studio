import {
  BrowserConnectionSchema,
  BrowserConnectionProbeSchema,
  BrowserProxyEntrySchema,
  BrowserWindowSchema,
  BrowserOperationSchema,
  type BrowserConnection,
  type BrowserConnectionProbe,
  type BrowserProxyEntry,
  type BrowserWindow,
  type BrowserOperation,
} from '@nexus/contracts/browser'
import { nativeApi, type NativeFolder } from '../api'
import { isNativeRaccoon } from '../runtime'
import {
  batchConnectionProblem,
  pendingCreateProblem,
  validBatchKernel,
  type ProfileBatchPorts,
} from './controller'
import type { FingerprintEntry } from '../../entities/fingerprint/model/types'
import { loadNativeProfileDefaults, type WorkbenchSettings } from '../settings-api'

export type ProfileBatchContext = {
  connection: BrowserConnection
  probe: BrowserConnectionProbe
  profiles: BrowserWindow[]
  operations: BrowserOperation[]
  folders: NativeFolder[]
  proxies: BrowserProxyEntry[]
  kernels: string[]
  aliasKernels: { chromium: string[]; firefox: string[] }
  fingerprints: FingerprintEntry[]
  licenseConfigured: boolean
  warning: string | null
  defaults: WorkbenchSettings['profileDefaults']
}

function fingerprints(value: unknown): FingerprintEntry[] {
  if (!Array.isArray(value)) throw new Error('指纹库返回格式无效')
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('指纹库返回格式无效')
    const item = entry as Record<string, unknown>
    if (
      ['id', 'label', 'platform', 'chrome', 'gpu', 'tag_color'].some(
        (key) => typeof item[key] !== 'string',
      ) ||
      typeof item.builtin !== 'boolean' ||
      !item.payload ||
      typeof item.payload !== 'object' ||
      Array.isArray(item.payload)
    )
      throw new Error('指纹库返回格式无效')
    return item as FingerprintEntry
  })
}

export function contextProblem(context: ProfileBatchContext): string | null {
  const problem = batchConnectionProblem(context.connection)
  if (problem) return problem
  const pending = pendingCreateProblem(context.operations, context.connection.id)
  if (pending) return pending
  if (!context.probe.connected) return context.probe.message || '无法连接此 Workspace'
  if (!context.probe.capabilities.create) return '此接入当前不支持创建 Profile'
  if (context.probe.scopeId !== context.connection.scopeId)
    return '当前厂商账号或 Workspace 与已确认的范围不一致，请到设置重新确认'
  if (context.connection.providerId === 'shardbrowser' && !context.kernels.length)
    return '请先在实验室下载 ShardBrowser 内核'
  if (context.connection.providerId === 'shardbrowser' && !context.fingerprints.length)
    return 'ShardBrowser 指纹库为空，请先导入可用指纹'
  if (context.connection.providerId === 'cloakbrowser' && !context.licenseConfigured)
    return '请先配置 CloakBrowser 激活码'
  return null
}

export const profileBatchApi = {
  async connections(): Promise<BrowserConnection[]> {
    if (!isNativeRaccoon()) throw new Error('批量创建需要 Raccoon 桌面原生环境')
    return BrowserConnectionSchema.array().parse(
      await nativeApi.call('browser_connection_list'),
    )
  },
  async context(connection: BrowserConnection): Promise<ProfileBatchContext> {
    const connectionId = connection.id
    const [profileRows, folderRows, proxyRows, probeValue, defaults, operationRows] =
      await Promise.all([
        nativeApi.call('browser_window_list', { connectionId }),
        nativeApi.call('browser_folder_list', { connectionId }),
        nativeApi.call('browser_proxy_list'),
        nativeApi.call('browser_connection_probe', { id: connectionId }),
        loadNativeProfileDefaults(),
        nativeApi.call('browser_operation_list', { connectionId }),
      ])
    const profiles = BrowserWindowSchema.array().parse(profileRows)
    const folders = folderRows as NativeFolder[]
    if (
      profiles.some((profile) => profile.connectionId !== connectionId) ||
      folders.some((folder) => folder.connectionId !== connectionId)
    )
      throw new Error('Profile 或 Folder 返回了其他 Workspace 的数据')
    let kernels: string[] = []
    const aliasKernels = { chromium: [] as string[], firefox: [] as string[] }
    let entries: FingerprintEntry[] = []
    let licenseConfigured = false
    let warning: string | null = null
    if (connection.providerId === 'shardbrowser') {
      const [status, library] = await Promise.all([
        nativeApi.call('shardbrowser_kernel_status'),
        nativeApi.call('shardbrowser_fingerprint_list', { connectionId }),
      ])
      kernels = (status as { installed: { version: string }[] }).installed.map(
        (kernel) => kernel.version,
      )
      entries = fingerprints(library)
    }
    if (connection.providerId === 'cloakbrowser') {
      const [license, status] = await Promise.all([
        nativeApi.call('license_status'),
        nativeApi.call('kernel_status', { refresh: false }).catch(() => null),
      ])
      licenseConfigured = (license as { configured: boolean }).configured
      if (status)
        kernels = (status as { installed: { version: string }[] }).installed.map(
          (kernel) => kernel.version,
        )
      else warning = '已安装内核清单读取失败。可刷新，或在已配置激活码时选择最新稳定版。'
    }
    if (connection.providerId === 'aliasmode') {
      await Promise.all(
        (['chromium', 'firefox'] as const).map(async (engine) => {
          try {
            const value = await nativeApi.call('aliasmode_kernel_status', { engine })
            if (
              !value ||
              typeof value !== 'object' ||
              !('installed' in value) ||
              !Array.isArray(value.installed)
            )
              throw new Error('AliasMode 内核状态返回格式无效')
            aliasKernels[engine] = value.installed.map((entry: unknown) => {
              if (
                !entry ||
                typeof entry !== 'object' ||
                !('version' in entry) ||
                typeof entry.version !== 'string' ||
                !validBatchKernel('aliasmode', engine, entry.version)
              )
                throw new Error('AliasMode 内核版本返回格式无效')
              return entry.version
            })
          } catch {
            warning =
              '部分 AliasMode 已安装内核清单读取失败，可重试读取或选择最新稳定版。'
          }
        }),
      )
    }
    return {
      connection: structuredClone(connection),
      probe: BrowserConnectionProbeSchema.parse(probeValue),
      profiles,
      operations: BrowserOperationSchema.array().parse(operationRows),
      folders,
      proxies: BrowserProxyEntrySchema.array().parse(proxyRows),
      kernels,
      aliasKernels,
      fingerprints: entries,
      licenseConfigured,
      warning,
      defaults,
    }
  },
  async checkConnection(
    snapshot: BrowserConnection,
    ownOperationId?: string,
  ): Promise<void> {
    const [connections, probeValue, operationRows] = await Promise.all([
      this.connections(),
      nativeApi.call('browser_connection_probe', { id: snapshot.id }),
      nativeApi.call('browser_operation_list', { connectionId: snapshot.id }),
    ])
    const connection = connections.find((entry) => entry.id === snapshot.id)
    if (
      !connection ||
      connection.revision !== snapshot.revision ||
      connection.providerId !== snapshot.providerId ||
      connection.scopeId !== snapshot.scopeId ||
      JSON.stringify(connection.capabilities) !== JSON.stringify(snapshot.capabilities)
    )
      throw new Error('本批 Workspace 配置已变化，请恢复原连接配置后重试')
    const problem = batchConnectionProblem(connection)
    if (problem) throw new Error(problem)
    const pending = pendingCreateProblem(
      BrowserOperationSchema.array().parse(operationRows),
      snapshot.id,
      ownOperationId,
    )
    if (pending) throw new Error(pending)
    const probe = BrowserConnectionProbeSchema.parse(probeValue)
    if (
      !probe.connected ||
      !probe.capabilities.create ||
      probe.scopeId !== snapshot.scopeId
    )
      throw new Error(probe.message || '本批 Workspace 尚未恢复可用状态')
  },
  async create(
    input: Parameters<ProfileBatchPorts['create']>[0],
  ): Promise<BrowserWindow> {
    return BrowserWindowSchema.parse(
      await nativeApi.call('browser_window_create', { input }),
    )
  },
  async reconcile(operationId: string): Promise<BrowserWindow | null> {
    const result = await nativeApi.call('browser_operation_reconcile', { operationId })
    return result === null ? null : BrowserWindowSchema.parse(result)
  },
}
