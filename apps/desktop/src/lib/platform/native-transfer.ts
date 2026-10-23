import { invoke, isTauri } from '@tauri-apps/api/core'

export type ImportMode = 'copy' | 'replace'

export interface TransferReport {
  windowCount: number
  ids: string[]
  warnings: string[]
  path?: string | null
}

export interface ExportReport extends TransferReport {
  path: string
}

export interface TransferRecoveryStatus {
  pending: number
  warnings: string[]
}

export interface TransferInspection {
  windows: { id: string; name: string; version: string; platform: string }[]
  sourcePlatform: string
  sourceArch: string
  plugins: { id: string; version: string }[]
  warnings: string[]
}

export interface SyncOffer {
  offerId: string
  invitation: string
  addresses: string[]
  /** Unix milliseconds, as returned by the sync plugin. */
  expiresAt: number
}

export interface SyncStatus {
  state: 'waiting' | 'transferring' | 'completed' | 'failed' | 'cancelled'
  bytes: number
  total: number
  error?: string
}

function invalid(): never {
  throw new Error('原生迁移返回的数据不完整或格式不符，请更新桌面应用后重试。')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) invalid()
  return value
}

function texts(value: unknown): string[] {
  if (!Array.isArray(value)) invalid()
  return value.map(text)
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid()
  return value
}

function report(value: unknown): TransferReport {
  const row = object(value)
  const ids = texts(row.ids)
  const windowCount = count(row.windowCount)
  if (windowCount !== ids.length || new Set(ids).size !== ids.length) invalid()
  return {
    windowCount,
    ids,
    warnings: texts(row.warnings),
    ...(row.path === undefined
      ? {}
      : { path: row.path === null ? null : text(row.path) }),
  }
}

export function transferError(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') {
    try {
      const parsed: unknown = JSON.parse(cause)
      if (parsed && typeof parsed === 'object' && 'message' in parsed) {
        return transferError(parsed)
      }
    } catch {
      // Plain text rejections are also part of the native bridge contract.
    }
    return cause
  }
  if (
    cause &&
    typeof cause === 'object' &&
    'message' in cause &&
    typeof cause.message === 'string'
  ) {
    return cause.message
  }
  return '迁移操作失败，请检查窗口是否已关闭、所需插件是否已安装，然后重试。'
}

async function call<T>(
  command: string,
  args: Record<string, unknown>,
  parse: (value: unknown) => T,
): Promise<T> {
  if (!isTauri()) throw new Error('窗口迁移仅在 Nexus 桌面应用中可用。')
  try {
    return parse(await invoke<unknown>(command, args))
  } catch (cause) {
    throw Object.assign(new Error(transferError(cause)), { cause })
  }
}

function selection(ids: string[]) {
  if (!ids.length || ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('请先选择需要迁移的已关闭窗口。')
  }
}

function snapshotPassword(password: string): string {
  if (!password.length) throw new Error('请输入快照密码。')
  return password
}

function importMode(mode: ImportMode): ImportMode {
  if (mode !== 'copy' && mode !== 'replace') throw new Error('请选择有效的导入方式。')
  return mode
}

export async function windowTransferRecovery(): Promise<TransferRecoveryStatus> {
  return call('profile_transfer_recovery_status', {}, (value) => {
    const row = object(value)
    return { pending: count(row.pending), warnings: texts(row.warnings) }
  })
}

export async function pickTransferPath(save: boolean): Promise<string | null> {
  return call('profile_transfer_pick', { save }, (value) =>
    value === null ? null : text(value),
  )
}

export async function exportWindows(
  ids: string[],
  password: string,
  path: string,
): Promise<ExportReport> {
  selection(ids)
  if (Array.from(password).length < 8) throw new Error('导出密码至少需要 8 个字符。')
  return call(
    'profile_transfer_export',
    { ids, password, path: text(path) },
    (value) => ({
      ...report(value),
      path: text(object(value).path),
    }),
  )
}

export async function inspectTransfer(
  path: string,
  password: string,
): Promise<TransferInspection> {
  return call(
    'profile_transfer_inspect',
    { path: text(path), password: snapshotPassword(password) },
    (value) => {
      const row = object(value)
      if (!Array.isArray(row.windows) || !Array.isArray(row.plugins)) invalid()
      const windows = row.windows.map((entry: unknown) => {
        const item = object(entry)
        return {
          id: text(item.id),
          name: text(item.name),
          version: text(item.version),
          platform: text(item.platform),
        }
      })
      if (new Set(windows.map((item) => item.id)).size !== windows.length) invalid()
      return {
        windows,
        sourcePlatform: text(row.sourcePlatform),
        sourceArch: text(row.sourceArch),
        plugins: row.plugins.map((entry: unknown) => {
          const item = object(entry)
          return { id: text(item.id), version: text(item.version) }
        }),
        warnings: texts(row.warnings),
      }
    },
  )
}

export async function importWindows(
  path: string,
  password: string,
  mode: ImportMode,
): Promise<TransferReport> {
  return call(
    'profile_transfer_import',
    { path: text(path), password: snapshotPassword(password), mode: importMode(mode) },
    report,
  )
}

export async function offerWindowSync(ids: string[]): Promise<SyncOffer> {
  selection(ids)
  return call('profile_sync_offer', { ids }, (value) => {
    const row = object(value)
    const expiresAt = count(row.expiresAt)
    if (!expiresAt) invalid()
    return {
      offerId: text(row.offerId),
      invitation: text(row.invitation),
      addresses: texts(row.addresses),
      expiresAt,
    }
  })
}

export async function windowSyncStatus(id: string): Promise<SyncStatus> {
  return call('profile_sync_status', { id: text(id) }, (value) => {
    const row = object(value)
    const state = row.state
    if (
      state !== 'waiting' &&
      state !== 'transferring' &&
      state !== 'completed' &&
      state !== 'failed' &&
      state !== 'cancelled'
    )
      invalid()
    const bytes = count(row.bytes)
    const total = count(row.total)
    if (bytes > total || (state === 'completed' && bytes !== total)) invalid()
    return {
      state,
      bytes,
      total,
      ...(row.error === undefined ? {} : { error: text(row.error) }),
    }
  })
}

export async function cancelWindowSync(id: string): Promise<void> {
  return call('profile_sync_cancel', { id: text(id) }, () => undefined)
}

export async function receiveWindowSync(
  invitation: string,
  host: string | null,
): Promise<{ jobId: string }> {
  return call(
    'profile_sync_receive',
    { invitation: text(invitation), host: host?.trim() || null },
    (value) => ({ jobId: text(object(value).jobId) }),
  )
}

export async function importWindowSync(
  id: string,
  mode: ImportMode,
): Promise<TransferReport> {
  return call('profile_sync_import', { id: text(id), mode: importMode(mode) }, report)
}
