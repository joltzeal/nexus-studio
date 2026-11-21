import { invoke, isTauri } from '@tauri-apps/api/core'

export interface AliasStatus {
  platform: string
  installed: { version: string; binaryPath: string }[]
  download: AliasJob
}
export interface AliasJob {
  phase: string
  percent: number | null
  error: string | null
}
export interface AliasRelease {
  version: string
  platform: string
  checkedAt: string
}

export function isAliasVersion(value: string): boolean {
  return value.length <= 64 && /^[0-9]+(?:\.[0-9]+){3}-aliasmode\.[0-9]+$/.test(value)
}
export function isAliasFirefoxVersion(value: string): boolean {
  return value.length <= 80 && /^aliasmode-runtime-[a-zA-Z0-9.-]+-r\d+$/.test(value)
}
export type AliasEngine = 'chromium' | 'firefox'
const versionFor = (engine: AliasEngine) => engine === 'firefox' ? isAliasFirefoxVersion : isAliasVersion
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function validStatus(value: unknown, engine: AliasEngine): value is AliasStatus {
  if (!record(value) || typeof value.platform !== 'string' || !Array.isArray(value.installed) || !record(value.download)) return false
  return value.installed.every((kernel: unknown) => record(kernel) && typeof kernel.version === 'string' && versionFor(engine)(kernel.version) && typeof kernel.binaryPath === 'string')
    && validJob(value.download)
}
function validJob(value: unknown): value is AliasJob {
  return record(value) && typeof value.phase === 'string'
    && (value.percent === null || typeof value.percent === 'number' && Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100)
    && (value.error === null || typeof value.error === 'string')
}
function validRelease(value: unknown, engine: AliasEngine): value is AliasRelease {
  return record(value) && typeof value.version === 'string' && versionFor(engine)(value.version)
    && typeof value.platform === 'string' && typeof value.checkedAt === 'string'
}
function desktop() {
  if (!isTauri()) throw new Error('请在桌面应用中管理内核')
}

export async function aliasStatus(engine: AliasEngine = 'chromium'): Promise<AliasStatus> {
  desktop()
  const value: unknown = await invoke('aliasmode_kernel_status', { engine })
  if (!validStatus(value, engine)) throw new Error('无法识别内核状态')
  return value
}
export async function aliasJob(engine: AliasEngine = 'chromium'): Promise<AliasJob> {
  desktop()
  const value: unknown = await invoke('aliasmode_kernel_job', { engine })
  if (!validJob(value)) throw new Error('无法识别下载进度')
  return value
}
export async function aliasLatest(engine: AliasEngine = 'chromium'): Promise<AliasRelease> {
  desktop()
  const value: unknown = await invoke('aliasmode_kernel_check_latest', { engine })
  if (!validRelease(value, engine)) throw new Error('无法识别发行版本')
  return value
}
export function aliasDownload(version?: string, engine: AliasEngine = 'chromium'): Promise<string> {
  desktop()
  if (version && !versionFor(engine)(version)) throw new Error('内核版本无效')
  return invoke<string>('aliasmode_kernel_download', { version: version ?? null, engine })
}

export function aliasDelete(version: string, engine: AliasEngine = 'chromium'): Promise<void> {
  desktop()
  if (!versionFor(engine)(version)) throw new Error('内核版本无效')
  return invoke<void>('aliasmode_kernel_delete', { version, engine })
}
