import { invoke, isTauri, Resource } from '@tauri-apps/api/core'
import { Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { create } from 'zustand'

const CHECK_DELAY = 10_000
const CHECK_INTERVAL = 6 * 60 * 60 * 1000

export type UpdatePhase =
  'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error'

type UpdateState = {
  phase: UpdatePhase
  version: string | null
  progress: number | null
  speedBytesPerSecond: number | null
  error: string | null
  install: () => Promise<void>
}

function updatable() {
  return isTauri() && import.meta.env.PROD
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function failure(cause: unknown) {
  const code = record(cause)?.code
  return typeof code === 'string' ? code : null
}

function message(cause: unknown) {
  switch (failure(cause)) {
    case 'proxy_settings':
      return '无法读取应用代理设置'
    case 'proxy_config':
      return '应用代理配置不可用'
    case 'update_source':
      return '更新源暂时不可用'
    case 'network':
    case 'timeout':
      return '无法连接更新源'
    case 'running_windows':
      return '请先停止运行中的 Profile'
    default:
      return '检查更新失败'
  }
}

function downloadFailure(cause: unknown) {
  const text = (
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  ).toLowerCase()
  return ['signature', 'minisign', 'different key', 'invalid encoding'].some((part) =>
    text.includes(part),
  )
    ? '更新包签名校验失败'
    : '更新包下载失败'
}

let candidate: Update | null = null
let running = false
let started = false

export const useAppUpdate = create<UpdateState>((set, get) => ({
  phase: 'idle',
  version: null,
  progress: null,
  speedBytesPerSecond: null,
  error: null,
  install: async () => {
    const update = candidate
    if (!update || get().phase !== 'ready') return
    set({ phase: 'installing', error: null })
    const rid = await invoke<unknown>('app_update_begin_install').catch((cause) => {
      const error =
        failure(cause) === 'running_windows'
          ? '请先停止运行中的 Profile，再重启更新'
          : '无法确认 Profile 状态'
      set({ phase: 'ready', error })
      throw new Error(error)
    })
    if (typeof rid !== 'number' || !Number.isSafeInteger(rid) || rid < 0) {
      const error = '无法确认 Profile 状态'
      set({ phase: 'ready', error })
      throw new Error(error)
    }
    const guard = new Resource(rid)
    try {
      await update.install()
    } catch (cause) {
      await guard.close().catch(() => {})
      candidate = update
      set({ phase: 'ready', error: downloadFailure(cause) })
      throw new Error(downloadFailure(cause))
    }
    await relaunch().catch(() => {
      set({ phase: 'installing', error: '更新已安装，请手动重新打开应用' })
      throw new Error('更新已安装，请手动重新打开应用')
    })
  },
}))

async function checkAndDownload() {
  if (running || !updatable()) return
  if (candidate || useAppUpdate.getState().phase === 'installing') return
  running = true
  useAppUpdate.setState({ phase: 'checking', error: null })
  try {
    const metadata = await invoke<unknown>('app_update_check')
    if (metadata === null) {
      useAppUpdate.setState({ phase: 'idle' })
      return
    }
    const update = new Update(metadata as ConstructorParameters<typeof Update>[0])
    useAppUpdate.setState({
      phase: 'downloading',
      version: update.version,
      progress: 0,
      speedBytesPerSecond: null,
    })
    let downloaded = 0
    let total: number | null = null
    let lastSampleAt = Date.now()
    let lastSampleBytes = 0
    await update.download((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? null
        downloaded = 0
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength
      }
      const now = Date.now()
      const elapsed = now - lastSampleAt
      let speedBytesPerSecond = useAppUpdate.getState().speedBytesPerSecond
      if (event.event === 'Progress' && elapsed >= 500) {
        speedBytesPerSecond = Math.round(
          ((downloaded - lastSampleBytes) * 1000) / elapsed,
        )
        lastSampleAt = now
        lastSampleBytes = downloaded
      }
      useAppUpdate.setState({
        progress: total ? Math.min(1, downloaded / total) : null,
        speedBytesPerSecond,
      })
    })
    candidate = update
    useAppUpdate.setState({ phase: 'ready', progress: 1 })
  } catch (cause) {
    useAppUpdate.setState({ phase: 'error', error: message(cause) })
  } finally {
    running = false
  }
}

/** Checks shortly after launch, then every six hours, downloading silently. */
export function startAppUpdateChecks() {
  if (started || !updatable()) return
  started = true
  window.setTimeout(() => void checkAndDownload(), CHECK_DELAY)
  window.setInterval(() => void checkAndDownload(), CHECK_INTERVAL)
}

export function formatDownloadRate(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) {
    return '速度未知'
  }
  return bytesPerSecond >= 1024 * 1024
    ? `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
    : `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`
}
