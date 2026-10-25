import { invoke, isTauri } from '@tauri-apps/api/core'

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
  binaryPath: string
}

export interface KernelRelease {
  version: string
  platform: string
  checkedAt: string
}

export function isKernelVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 48 &&
    value.trim() === value &&
    /^[0-9]+(?:\.[0-9]+){3,4}$/.test(value)
  )
}

export interface KernelDownload {
  phase: KernelPhase
  percent: number | null
  downloadedMb: number | null
  totalMb: number | null
  attempt: number | null
  version: string | null
  /** Missing only on older hosts; null requests latest, a string pins a package. */
  requestedVersion?: string | null
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
      !isKernelVersion(entry.version) ||
      !isText(entry.binaryPath)
    ) {
      return null
    }
    installed.push({
      version: entry.version.trim(),
      binaryPath: entry.binaryPath,
    })
  }
  const download = value.download
  if (
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
    (download.version !== null && !isText(download.version)) ||
    (download.requestedVersion != null && !isKernelVersion(download.requestedVersion))
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
      phase: download.phase,
      percent: download.percent,
      downloadedMb: download.downloadedMb,
      totalMb: download.totalMb,
      attempt: download.attempt,
      version: download.version === null ? null : download.version.trim(),
      ...(download.requestedVersion === undefined
        ? {}
        : { requestedVersion: download.requestedVersion as string | null }),
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

export async function downloadKernel(version?: string | null): Promise<string> {
  requireDesktop()
  if (version != null && !isKernelVersion(version)) {
    throw new KernelOperationError({
      code: 'invalid_version',
      message: '请输入由 4–5 段数字组成的完整包版本，最多 48 个字符。',
      retryable: false,
    })
  }
  try {
    const result =
      version == null
        ? await invoke<unknown>('kernel_download')
        : await invoke<unknown>('kernel_download', { version })
    if (!isText(result)) throw invalidResponse()
    return result.trim()
  } catch (cause) {
    throw operationError(cause, '内核下载失败，请重试。')
  }
}

export async function checkLatestKernel(): Promise<KernelRelease> {
  requireDesktop()
  try {
    const result = await invoke<unknown>('kernel_check_latest')
    if (
      !isRecord(result) ||
      !isKernelVersion(result.version) ||
      !isText(result.platform) ||
      !['darwin-arm64', 'darwin-x64', 'windows-x64', 'linux-arm64', 'linux-x64'].includes(
        result.platform,
      ) ||
      !isText(result.checkedAt) ||
      !/^\d{4}-\d{2}-\d{2}T/.test(result.checkedAt) ||
      !Number.isFinite(Date.parse(result.checkedAt))
    ) {
      throw invalidResponse()
    }
    return {
      version: result.version,
      platform: result.platform,
      checkedAt: result.checkedAt,
    }
  } catch (cause) {
    throw operationError(cause, '无法检查最新内核，请检查应用代理或网络后重试。')
  }
}
