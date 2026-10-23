import type { SyncStatus, TransferRecoveryStatus } from '@/lib/platform/native-transfer'

export function toggleSelection(
  current: ReadonlySet<string>,
  ids: string[],
  checked: boolean,
): Set<string> {
  const next = new Set(current)
  for (const id of ids) {
    if (checked) next.add(id)
    else next.delete(id)
  }
  return next
}

export function selectionError(
  windows: { id: string; running: boolean }[],
  operating: ReadonlySet<string> = new Set(),
): string | null {
  if (!windows.length) return '请先选择需要迁移的已关闭窗口。'
  if (windows.some((window) => window.running)) return '请先关闭所有选中的窗口。'
  if (windows.some((window) => operating.has(window.id))) {
    return '选中的窗口正在操作，请等待操作结束后重试。'
  }
  return null
}

export function exportPasswordError(
  password: string,
  confirmation: string,
): string | null {
  if (Array.from(password).length < 8) return '导出密码至少需要 8 个字符。'
  if (password !== confirmation) return '两次输入的密码不一致。'
  return null
}

export function canImportReceived(
  direction: 'send' | 'receive',
  status: SyncStatus | null,
  imported: boolean,
  cancelled = false,
): boolean {
  return (
    direction === 'receive' && status?.state === 'completed' && !imported && !cancelled
  )
}

export class WaitTimeoutError extends Error {}

/** Ending a UI wait does not cancel the native operation. */
export function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      reject(new Error('已停止读取状态。'))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new WaitTimeoutError(timeoutMessage))
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    operation.then(
      (result) => {
        cleanup()
        resolve(result)
      },
      (cause: unknown) => {
        cleanup()
        reject(cause)
      },
    )
  })
}

/** One recovery check; cleanup stops observation without cancelling native recovery. */
export function observeTransferRecovery(
  read: () => Promise<TransferRecoveryStatus>,
  onStatus: (status: TransferRecoveryStatus) => void,
  onError: (cause: unknown) => void,
): () => void {
  const controller = new AbortController()
  async function check() {
    try {
      const status = await withDeadline(
        read(),
        10_000,
        '读取窗口迁移恢复状态超时，原生恢复任务仍可能继续。请稍后刷新重试。',
        controller.signal,
      )
      if (!controller.signal.aborted) onStatus(status)
    } catch (cause) {
      if (!controller.signal.aborted) onError(cause)
    }
  }
  void check()
  return () => controller.abort()
}

/** Serial polling; cleanup stops observation, only the Cancel button cancels a job. */
export function watchSyncStatus(
  read: () => Promise<SyncStatus>,
  onStatus: (status: SyncStatus) => void,
  onError: (cause: unknown) => void,
): () => void {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  async function poll() {
    try {
      const status = await withDeadline(
        read(),
        10_000,
        '读取同步进度超时，传输结果尚未确认。请重试读取状态或显式取消任务。',
        controller.signal,
      )
      if (controller.signal.aborted) return
      onStatus(status)
      if (status.state === 'waiting' || status.state === 'transferring') {
        timer = setTimeout(() => void poll(), 1000)
      }
    } catch (cause) {
      if (!controller.signal.aborted) onError(cause)
    }
  }
  void poll()
  return () => {
    clearTimeout(timer)
    controller.abort()
  }
}
