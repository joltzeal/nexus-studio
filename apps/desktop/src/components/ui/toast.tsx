import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { cn } from 'cn'
import { Button } from './button'

/**
 * Toasts are page-level feedback for transient results such as "copied".
 * The store lives outside React so any module can report a result without a
 * provider, and `<Toaster />` is mounted once at the app root.
 */
export type ToastTone = 'success' | 'error' | 'info'

export interface ToastItem {
  id: number
  tone: ToastTone
  message: string
  action?: {
    label: string
    onClick: () => void
  }
}

interface ToastOptions {
  /** Zero retains a notice until dismissed, including while queued. */
  duration?: number
  action?: ToastItem['action']
}

/** Persistent overflow waits in order; only transient notices may be evicted. */
export const MAX_TOASTS = 3

const DURATION: Record<ToastTone, number> = {
  success: 2600,
  info: 3600,
  error: 5200,
}

// The first MAX_TOASTS are visible; the remaining persistent notices are queued.
let items: (ToastItem & { persistent: boolean })[] = []
let nextId = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function clearTimer(id: number) {
  const timer = timers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
}

export function dismissToast(id: number) {
  clearTimer(id)
  const next = items.filter((item) => item.id !== id)
  if (next.length === items.length) return
  items = next
  emit()
}

export function pushToast(
  tone: ToastTone,
  message: string,
  options: ToastOptions = {},
): number {
  const text = message.trim()
  if (text === '') return 0
  const id = nextId++
  const duration = options.duration ?? DURATION[tone]
  // Replace duplicate messages across both visible and queued notices.
  for (const item of items) {
    if (item.message === text) clearTimer(item.id)
  }
  items = [
    ...items.filter((item) => item.message !== text),
    {
      id,
      tone,
      message: text,
      persistent: duration === 0,
      ...(options.action ? { action: options.action } : {}),
    },
  ]
  while (items.length > MAX_TOASTS) {
    const dropped = items.find((item) => !item.persistent)
    if (dropped === undefined) break
    clearTimer(dropped.id)
    items = items.filter((item) => item.id !== dropped.id)
  }
  if (duration > 0 && items.some((item) => item.id === id))
    timers.set(
      id,
      setTimeout(() => dismissToast(id), duration),
    )
  emit()
  return id
}

export const toast = {
  success: (message: string) => pushToast('success', message),
  error: (message: string) => pushToast('error', message),
  info: (message: string, options?: ToastOptions) => pushToast('info', message, options),
  dismiss: dismissToast,
}

export function clearToasts() {
  for (const id of timers.keys()) clearTimer(id)
  items = []
  emit()
}

/** Test seam: reads the visible list without subscribing. */
export function toastSnapshot(): readonly ToastItem[] {
  return items.slice(0, MAX_TOASTS)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot() {
  return items
}

const TONE_ICON = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
} as const

export function Toaster() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const pendingCount = Math.max(0, current.length - MAX_TOASTS)

  if (current.length === 0) return null
  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="toast-viewport" role="region" aria-label="操作提示">
      {current.slice(0, MAX_TOASTS).map((item) => {
        const Icon = TONE_ICON[item.tone]
        return (
          <div
            key={item.id}
            className={cn('toast', `toast-${item.tone}`)}
            role={item.tone === 'error' ? 'alert' : 'status'}
            aria-live={item.tone === 'error' ? 'assertive' : 'polite'}
          >
            <Icon className="toast-icon" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
              <p className="toast-message">{item.message}</p>
              {item.action ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={item.action.onClick}
                >
                  {item.action.label}
                </Button>
              ) : null}
            </div>
            <button
              type="button"
              className="toast-close"
              aria-label="关闭提示"
              onClick={() => dismissToast(item.id)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        )
      })}
      {pendingCount > 0 ? (
        <p
          className="rounded-md border bg-popover px-2 py-1 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          还有 {pendingCount} 条提示待查看
        </p>
      ) : null}
    </div>,
    document.body,
  )
}
