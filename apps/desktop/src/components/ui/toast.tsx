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
  /** Zero keeps an actionable notice visible until dismissed. */
  duration?: number
  action?: ToastItem['action']
}

/** Evict transient entries first, keeping the viewport bounded even if all persist. */
export const MAX_TOASTS = 3

const DURATION: Record<ToastTone, number> = {
  success: 2600,
  info: 3600,
  error: 5200,
}

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
  // The same message twice in a row would stack identical boxes, so the older
  // one is replaced instead of duplicated.
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
    const dropped = items.find((item) => !item.persistent) ?? items[0]
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

/** Test seam: reads the current list without subscribing. */
export function toastSnapshot(): readonly ToastItem[] {
  return items
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

  if (current.length === 0) return null
  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="toast-viewport" role="region" aria-label="操作提示">
      {current.map((item) => {
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
    </div>,
    document.body,
  )
}
