import { invoke, isTauri } from '@tauri-apps/api/core'

export type KernelKind = 'base' | 'latest'
export type KernelPhase =
  | 'idle'
  | 'preparing'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'retrying'
  | 'ready'
  | 'failed'

export interface KernelFailure {
  code: string
  message: string
  retryable: boolean
}

export interface InstalledKernel {
  version: string
  kind: KernelKind
  binaryPath: string
}

export interface KernelDownload {
  kind: KernelKind | null
  phase: KernelPhase
  percent: number | null
  downloadedMb: number | null
  totalMb: number | null
  attempt: number | null
  version: string | null
  error: KernelFailure | null
}

export interface KernelStatus {
  cacheDir: string
  platform: string
  installed: InstalledKernel[]
  activationConfigured: boolean
  download: KernelDownload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isKind(value: unknown): value is KernelKind {
  return value === 'base' || value === 'latest'
}

function isPhase(value: unknown): value is KernelPhase {
  return [
    'idle',
    'preparing',
    'downloading',
    'verifying',
    'extracting',
    'retrying',
    'ready',
    'failed',
  ].some((phase) => phase === value)
}

function isMeasurement(value: unknown): value is number | null {
  return (
    value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  )
}

function parseFailure(value: unknown): KernelFailure | null {
  if (
    !isRecord(value) ||
    !isText(value.code) ||
    !isText(value.message) ||
    typeof value.retryable !== 'boolean'
  ) {
    return null
  }
  return {
    code: value.code.trim(),
    message: value.message.trim(),
    retryable: value.retryable,
  }
}

function parseStatus(value: unknown): KernelStatus | null {
  if (
    !isRecord(value) ||
    !isText(value.cacheDir) ||
    !isText(value.platform) ||
    !Array.isArray(value.installed) ||
    typeof value.activationConfigured !== 'boolean' ||
    !isRecord(value.download)
  ) {
    return null
  }
  const installed: InstalledKernel[] = []
  for (const entry of value.installed) {
    if (
      !isRecord(entry) ||
      !isText(entry.version) ||
      !isKind(entry.kind) ||
      !isText(entry.binaryPath)
    ) {
      return null
    }
    installed.push({
      version: entry.version.trim(),
      kind: entry.kind,
      binaryPath: entry.binaryPath,
    })
  }
  const download = value.download
  if (
    (download.kind !== null && !isKind(download.kind)) ||
    !isPhase(download.phase) ||
    !isMeasurement(download.percent) ||
    (download.percent !== null && download.percent > 100) ||
    !isMeasurement(download.downloadedMb) ||
    !isMeasurement(download.totalMb) ||
    !isMeasurement(download.attempt) ||
    (download.attempt !== null &&
      (!Number.isInteger(download.attempt) ||
        download.attempt < 1 ||
        download.attempt > 3)) ||
    (download.version !== null && !isText(download.version))
  ) {
    return null
  }
  const error = parseFailure(download.error)
  if (download.error !== null && error === null) return null
  return {
    cacheDir: value.cacheDir,
    platform: value.platform,
    installed,
    activationConfigured: value.activationConfigured,
    download: {
      kind: download.kind,
      phase: download.phase,
      percent: download.percent,
      downloadedMb: download.downloadedMb,
      totalMb: download.totalMb,
      attempt: download.attempt,
      version: download.version === null ? null : download.version.trim(),
      error,
    },
  }
}

export class KernelOperationError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(failure: KernelFailure) {
    super(failure.message)
    this.name = 'KernelOperationError'
    this.code = failure.code
    this.retryable = failure.retryable
  }
}

export function nativeKernelsAvailable(): boolean {
  return isTauri()
}

function requireDesktop() {
  if (!nativeKernelsAvailable()) {
    throw new KernelOperationError({
      code: 'desktop_only',
      message: '请在桌面应用中管理浏览器内核。',
      retryable: false,
    })
  }
}

function operationError(cause: unknown, fallback: string): KernelOperationError {
  if (cause instanceof KernelOperationError) return cause
  if (typeof cause === 'string') {
    try {
      cause = JSON.parse(cause) as unknown
    } catch {
      // Unstructured bridge errors can contain private native diagnostics.
    }
  }
  const parsed = parseFailure(cause)
  return new KernelOperationError(
    parsed ?? { code: 'native_error', message: fallback, retryable: true },
  )
}

function invalidResponse(): KernelOperationError {
  return new KernelOperationError({
    code: 'invalid_response',
    message: '内核服务返回的数据无效，请刷新后重试。',
    retryable: true,
  })
}

export async function getKernelStatus(refresh = false): Promise<KernelStatus> {
  requireDesktop()
  try {
    const parsed = parseStatus(await invoke<unknown>('kernel_status', { refresh }))
    if (!parsed) throw invalidResponse()
    return parsed
  } catch (cause) {
    throw operationError(cause, '无法读取内核状态，请重试。')
  }
}

export async function downloadKernel(kind: KernelKind): Promise<string> {
  requireDesktop()
  try {
    const result = await invoke<unknown>('kernel_download', { kind })
    if (!isText(result)) throw invalidResponse()
    return result.trim()
  } catch (cause) {
    throw operationError(cause, '内核下载失败，请重试。')
  }
}
