import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { cn } from 'cn'

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
}

/** Visible toasts. Older entries are dropped so a burst cannot cover the page. */
export const MAX_TOASTS = 3

const DURATION: Record<ToastTone, number> = {
  success: 2600,
  info: 3600,
  error: 5200,
}

let items: ToastItem[] = []
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

export function pushToast(tone: ToastTone, message: string): number {
  const text = message.trim()
  if (text === '') return 0
  const id = nextId++
  // The same message twice in a row would stack identical boxes, so the older
  // one is replaced instead of duplicated.
  items = [...items.filter((item) => item.message !== text), { id, tone, message: text }]
  while (items.length > MAX_TOASTS) {
    const dropped = items[0]
    if (dropped === undefined) break
    clearTimer(dropped.id)
    items = items.slice(1)
  }
  timers.set(
    id,
    setTimeout(() => dismissToast(id), DURATION[tone]),
  )
  emit()
  return id
}

export const toast = {
  success: (message: string) => pushToast('success', message),
  error: (message: string) => pushToast('error', message),
  info: (message: string) => pushToast('info', message),
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
            <p className="toast-message">{item.message}</p>
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
