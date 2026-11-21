import { invoke, isTauri } from '@tauri-apps/api/core'

export interface ShardStatus {
  platform: string
  installed: { version: string; binaryPath: string }[]
  downloading: boolean
  download: {
    phase: 'idle' | 'preparing' | 'downloading' | 'extracting' | 'verifying' | 'ready' | 'failed'
    label: string | null
    receivedBytes: number
    totalBytes: number | null
    percent: number | null
    error: string | null
  }
}

export const isShardVersion = (value: string) =>
  value.length <= 48 && /^\d+(?:\.\d+){3}$/.test(value)

export async function shardStatus(): Promise<ShardStatus> {
  if (!isTauri()) throw new Error('请在桌面应用中管理内核')
  const value: unknown = await invoke('shardbrowser_kernel_status')
  if (typeof value !== 'object' || value === null || !('installed' in value) || !Array.isArray(value.installed)
    || !('platform' in value) || typeof value.platform !== 'string'
    || !('downloading' in value) || typeof value.downloading !== 'boolean'
    || !value.installed.every((entry: unknown) => typeof entry === 'object' && entry !== null && 'version' in entry && typeof entry.version === 'string' && isShardVersion(entry.version) && 'binaryPath' in entry && typeof entry.binaryPath === 'string')) {
    throw new Error('无法识别内核清单')
  }
  if (!('download' in value) || !value.download || typeof value.download !== 'object') throw new Error('无法识别内核下载进度')
  const job = value.download as Record<string, unknown>
  if (typeof job.phase !== 'string' || !['idle', 'preparing', 'downloading', 'extracting', 'verifying', 'ready', 'failed'].includes(job.phase)
    || (job.label !== null && typeof job.label !== 'string')
    || typeof job.receivedBytes !== 'number' || !Number.isSafeInteger(job.receivedBytes) || job.receivedBytes < 0
    || (job.totalBytes !== null && (typeof job.totalBytes !== 'number' || !Number.isSafeInteger(job.totalBytes) || job.totalBytes <= 0))
    || (job.percent !== null && (typeof job.percent !== 'number' || !Number.isFinite(job.percent) || job.percent < 0 || job.percent > 100))
    || (job.error !== null && typeof job.error !== 'string')
    || value.downloading !== ['preparing', 'downloading', 'extracting', 'verifying'].includes(job.phase)
    || (job.percent !== null && (job.phase !== 'downloading' || job.totalBytes === null))) throw new Error('无法识别内核下载进度')
  return value as ShardStatus
}

export function shardDownload(): Promise<string> {
  if (!isTauri()) return Promise.reject(new Error('请在桌面应用中管理内核'))
  return invoke('shardbrowser_kernel_download')
}

export function shardDelete(version: string): Promise<void> {
  if (!isShardVersion(version)) return Promise.reject(new Error('内核版本无效'))
  return invoke('shardbrowser_kernel_delete', { version })
}
