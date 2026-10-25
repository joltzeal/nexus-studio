export type KernelFailureCode =
  | 'NETWORK'
  | 'NOT_FOUND'
  | 'MANIFEST_UNAVAILABLE'
  | 'ACTIVATION'
  | 'SIGNATURE'
  | 'CHECKSUM'
  | 'VERSION'
  | 'PERMISSION'
  | 'STORAGE'
  | 'VERIFICATION'
  | 'DOWNLOAD'
  | 'UNKNOWN'

export interface KernelFailure {
  code: KernelFailureCode
  message: string
  retryable: boolean
}

export interface KernelProgress {
  phase: 'downloading' | 'verifying' | 'extracting' | 'retrying'
  percent?: number
  downloadedMb?: number
  totalMb?: number
  attempt?: number
}

const NETWORK_CODES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
] as const
const RETRY_DELAYS_MS = [250, 500] as const
const MAX_ERROR_CAUSES = 32

function errorField(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined
  try {
    return (error as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function errorDetails(error: unknown): {
  messages: string
  codes: string[]
  names: string[]
  statuses: number[]
} {
  const pending: unknown[] = [error]
  const seen = new Set<unknown>()
  const messages: string[] = []
  const codes: string[] = []
  const names: string[] = []
  const statuses: number[] = []

  for (let index = 0; index < pending.length && index < MAX_ERROR_CAUSES; index++) {
    const current = pending[index]
    if (seen.has(current)) continue
    seen.add(current)
    const message = typeof current === 'string' ? current : errorField(current, 'message')
    const code = errorField(current, 'code')
    const name = errorField(current, 'name')
    if (typeof message === 'string') {
      messages.push(message)
      for (const match of message.matchAll(/\bHTTP\s+([1-5]\d{2})\b/gi)) {
        statuses.push(Number(match[1]))
      }
    }
    if (typeof code === 'string') codes.push(code)
    if (typeof name === 'string') names.push(name)
    for (const key of ['status', 'statusCode']) {
      const status = errorField(current, key)
      if (
        typeof status === 'number' &&
        Number.isInteger(status) &&
        status >= 100 &&
        status < 600
      ) {
        statuses.push(status)
      }
    }
    const cause = errorField(current, 'cause')
    if (cause !== undefined) pending.push(cause)
    const errors = errorField(current, 'errors')
    const count = errorField(errors, 'length')
    if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0) {
      for (let child = 0; child < Math.min(count, MAX_ERROR_CAUSES); child++) {
        pending.push(errorField(errors, String(child)))
      }
    }
  }

  return { messages: messages.join('\n'), codes, names, statuses }
}

export function kernelFailure(error: unknown): KernelFailure {
  const { messages, codes, names, statuses } = errorDetails(error)
  const failure = (
    code: KernelFailureCode,
    message: string,
    retryable = false,
  ): KernelFailure => ({ code, message, retryable })

  if (messages.includes('ACTIVATION_REQUIRED')) {
    return failure('ACTIVATION', '请先在设置中填写激活码。')
  }
  if (messages.includes('PROFILE_ENGINE_UNSUPPORTED')) {
    return failure('VERSION', '此内核不受支持，请下载最新内核并重新创建窗口。')
  }
  if (messages.includes('KERNEL_RELEASE_INVALID')) {
    return failure('VERSION', '最新内核版本信息无效，请稍后重新检查。', true)
  }
  if (messages.includes('KERNEL_LATEST_UNAVAILABLE')) {
    return failure(
      'DOWNLOAD',
      '最新内核未能下载完成，本机原内核仍保留，请检查应用代理或网络后重试。',
      true,
    )
  }
  // Permanent failures take precedence over transient errors anywhere in the cause chain.
  if (
    codes.some((code) => ['EACCES', 'EPERM', 'EROFS'].includes(code)) ||
    /\b(?:EACCES|EPERM|EROFS|permission denied|read-only file system)\b/i.test(messages)
  ) {
    return failure(
      'PERMISSION',
      '无法写入或执行本地内核文件，请检查应用数据目录的访问权限。',
    )
  }
  if (codes.includes('ENOSPC') || /\bENOSPC\b|no space left on device/i.test(messages)) {
    return failure('STORAGE', '磁盘空间不足，请清理空间后重新下载内核。')
  }
  if (
    /SHA256SUMS signature verification failed|malformed SHA256SUMS\.sig|signature (?:verification )?(?:failed|mismatch|invalid)/i.test(
      messages,
    )
  ) {
    return failure('SIGNATURE', '内核签名校验失败，已停止安装，请重新下载。')
  }
  if (
    /checksum (?:verification )?(?:failed|mismatch)|SHA-?256 mismatch/i.test(messages)
  ) {
    return failure('CHECKSUM', '内核文件校验失败，已停止安装，请重新下载。')
  }
  if (
    /version mismatch|invalid browser version pin|PROFILE_ENGINE_MISMATCH|BINARY_VERSION_UNKNOWN/i.test(
      messages,
    )
  ) {
    return failure('VERSION', '内核版本无效或与请求的版本不一致，已停止安装。')
  }
  if (
    names.includes('BinaryVerificationError') ||
    /cannot confirm binary integrity|signature-verified (?:Pro )?SHA256SUMS has no entry/i.test(
      messages,
    )
  ) {
    return failure('VERIFICATION', '无法确认内核文件的完整性，已停止安装。')
  }
  if (
    /license (?:key )?(?:is )?(?:invalid|expired|revoked|required)|(?:invalid|expired|revoked)(?: or expired)? license|license.*(?:has expired|was revoked)/i.test(
      messages,
    )
  ) {
    return failure('ACTIVATION', '激活服务未接受此激活码或内核请求，请在设置中重新校验。')
  }
  if (
    /could not fetch (?:the |a )?signed SHA256SUMS|HTTP [1-5]\d{2} for SHA256SUMS/i.test(
      messages,
    )
  ) {
    return failure(
      'MANIFEST_UNAVAILABLE',
      '无法获取内核校验文件，请检查应用代理或网络后重试。',
      true,
    )
  }
  if (statuses.includes(404)) {
    return failure('NOT_FOUND', '当前平台的内核下载不可用（HTTP 404），请稍后重试。')
  }
  if (statuses.includes(401) || statuses.includes(403)) {
    return failure(
      'ACTIVATION',
      '内核下载请求被拒绝（HTTP 401/403），请检查激活码及网络设置。',
    )
  }
  if (
    statuses.some(
      (status) => status >= 400 && status < 500 && ![408, 425, 429].includes(status),
    )
  ) {
    return failure('DOWNLOAD', '内核下载请求被服务器拒绝，请稍后重试。')
  }

  const networkCode = NETWORK_CODES.find(
    (code) => codes.includes(code) || new RegExp(`\\b${code}\\b`).test(messages),
  )
  if (networkCode) {
    return failure(
      'NETWORK',
      `内核下载连接失败（${networkCode}），请检查应用代理或网络后重试。`,
      true,
    )
  }
  if (
    statuses.some((status) => status >= 500 || [408, 425, 429].includes(status)) ||
    names.some((name) => name === 'TimeoutError' || name === 'AbortError') ||
    /\bfetch failed\b|could not determine latest Pro version from server|license could not be validated|server unreachable|\b(?:connection|download|request) (?:timed out|timeout)\b/i.test(
      messages,
    )
  ) {
    return failure('NETWORK', '暂时无法连接内核服务，请检查应用代理或网络后重试。', true)
  }
  return failure('UNKNOWN', '内核准备失败，请重新下载；若仍失败，请检查网络和本地存储。')
}

export async function retryKernelPreparation<T>(
  prepare: () => Promise<T>,
  onProgress?: (progress: KernelProgress) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prepare()
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !kernelFailure(error).retryable) throw error
      onProgress?.({ phase: 'retrying', attempt: attempt + 2 })
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
    }
  }
}

export function kernelProgressFromLog(log: string): KernelProgress | null {
  const line = log.trim()
  const progress =
    /^\[cloakbrowser\] Download progress: (\d+(?:\.\d+)?)% \((\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?) MB\)$/.exec(
      line,
    )
  if (progress) {
    const percent = Number(progress[1])
    const downloadedMb = Number(progress[2])
    const totalMb = Number(progress[3])
    if (
      ![percent, downloadedMb, totalMb].every(Number.isFinite) ||
      percent > 100 ||
      downloadedMb > totalMb
    ) {
      return null
    }
    return { phase: 'downloading', percent, downloadedMb, totalMb }
  }
  if (
    /^\[cloakbrowser\] Download complete: \d+(?:\.\d+)? MB$/.test(line) ||
    line === '[cloakbrowser] SHA256SUMS signature verified: Ed25519 OK' ||
    line === '[cloakbrowser] Checksum verified: SHA-256 OK'
  ) {
    return { phase: 'verifying' }
  }
  if (/^\[cloakbrowser\] Extracting to [^\r\n]+$/.test(line)) {
    return { phase: 'extracting' }
  }
  return null
}
