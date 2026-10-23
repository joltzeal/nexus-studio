import { invoke, isTauri, Resource } from '@tauri-apps/api/core'
import { Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export type AvailableUpdate = Update

const errorMessages = {
  desktop_only: '请在发行版桌面应用中检查更新。',
  proxy_settings: '无法读取应用代理设置，请在应用设置中检查后重试。',
  proxy_config: '应用代理配置不可用，请检查手动地址或系统代理；系统 PAC 暂不支持。',
  updater_config: '此安装包的更新配置不可用，请从官方发布页重新安装。',
  update_source: '更新源未提供有效的发布清单，请检查官方发布页或稍后重试。',
  manifest: '更新清单格式无效，请稍后重试或从官方发布页下载安装。',
  platform: '更新清单缺少当前平台的安装包，请从官方发布页检查对应平台。',
  timeout: '检查更新超时，请检查网络和应用代理后重试。',
  network: '无法连接更新源，请检查网络和应用代理；代理失败不会自动直连。',
  check_failed: '检查更新失败，请重试或从官方发布页下载安装。',
  invalid_response: '更新服务返回的数据无效，请重试或重新安装应用。',
  profiles_failed: '无法确认窗口状态，请退出并重新打开应用后重试。',
  running_windows:
    '请先停止所有运行中的窗口，并等待启动、关闭或迁移操作完成，再安装更新。',
  signature: '更新包签名验证失败，已停止安装，请重新检查更新。',
  download_failed: '更新包下载失败，请检查网络和应用代理后重新检查更新。',
  not_downloaded: '更新包尚未准备完成，请稍后重试。',
  install_failed: '安装更新失败，请重试或从官方发布页下载安装。',
  relaunch_failed: '更新已安装，但无法自动重启，请手动退出并重新打开应用。',
} as const

export class AppUpdateError extends Error {
  constructor(readonly code: keyof typeof errorMessages) {
    super(errorMessages[code])
    this.name = 'AppUpdateError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMetadata(value: unknown): value is ConstructorParameters<typeof Update>[0] {
  return (
    isRecord(value) &&
    typeof value.rid === 'number' &&
    Number.isSafeInteger(value.rid) &&
    value.rid >= 0 &&
    typeof value.currentVersion === 'string' &&
    value.currentVersion.trim().length > 0 &&
    typeof value.version === 'string' &&
    value.version.trim().length > 0 &&
    (value.body === undefined || typeof value.body === 'string') &&
    (value.date === undefined || typeof value.date === 'string') &&
    isRecord(value.rawJson)
  )
}

function checkError(cause: unknown): AppUpdateError {
  if (cause instanceof AppUpdateError) return cause
  if (isRecord(cause) && typeof cause.code === 'string') {
    const code = cause.code
    if (
      code === 'proxy_settings' ||
      code === 'proxy_config' ||
      code === 'updater_config' ||
      code === 'update_source' ||
      code === 'manifest' ||
      code === 'platform' ||
      code === 'timeout' ||
      code === 'network'
    ) {
      return new AppUpdateError(code)
    }
  }
  return new AppUpdateError('check_failed')
}

function packageError(
  cause: unknown,
  fallback: 'download_failed' | 'install_failed',
): AppUpdateError {
  // The Tauri download API rejects with strings. Never display its raw diagnostics.
  const message = (
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  ).toLowerCase()
  if (
    [
      'signature',
      'minisign',
      'signed for version',
      'different key',
      'invalid encoding',
    ].some((part) => message.includes(part))
  ) {
    return new AppUpdateError('signature')
  }
  if (
    ['error sending request', 'download request failed', 'timed out', 'timeout'].some(
      (part) => message.includes(part),
    )
  ) {
    return new AppUpdateError('download_failed')
  }
  return new AppUpdateError(fallback)
}

export function updatesAvailable(): boolean {
  return isTauri() && import.meta.env.PROD
}

export async function checkAppUpdate(): Promise<AvailableUpdate | null> {
  if (!updatesAvailable()) throw new AppUpdateError('desktop_only')
  try {
    const metadata = await invoke<unknown>('app_update_check')
    if (metadata === null) return null
    if (!isMetadata(metadata)) throw new AppUpdateError('invalid_response')
    return new Update(metadata)
  } catch (cause) {
    throw checkError(cause)
  }
}

export async function downloadAppUpdate(
  update: AvailableUpdate,
  onProgress: (downloaded: number, total: number | null) => void,
): Promise<void> {
  let downloaded = 0
  let total: number | null = null
  try {
    // Finished precedes signature verification; only the resolved download is ready.
    await update.download((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? null
        downloaded = 0
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength
      }
      onProgress(downloaded, total)
    })
  } catch (cause) {
    throw packageError(cause, 'download_failed')
  }
}

export async function installAppUpdate(update: AvailableUpdate): Promise<void> {
  const rid = await invoke<unknown>('app_update_begin_install').catch(
    (cause: unknown) => {
      throw new AppUpdateError(
        isRecord(cause) && cause.code === 'running_windows'
          ? 'running_windows'
          : 'profiles_failed',
      )
    },
  )
  if (typeof rid !== 'number' || !Number.isSafeInteger(rid) || rid < 0) {
    throw new AppUpdateError('profiles_failed')
  }
  const guard = new Resource(rid)
  try {
    await update.install()
  } catch (cause) {
    await guard.close().catch(() => {
      throw new AppUpdateError('profiles_failed')
    })
    throw packageError(cause, 'install_failed')
  }
  // Relaunch may resolve before exit. The app owns the guard until that exit,
  // including when the user must restart manually after a relaunch failure.
  await relaunch().catch(() => {
    throw new AppUpdateError('relaunch_failed')
  })
}
