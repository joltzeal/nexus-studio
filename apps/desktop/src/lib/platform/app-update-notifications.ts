import { toast } from '@/components/ui/toast'
import { checkAppUpdate, updatesAvailable, type AvailableUpdate } from './app-updates'

export const UPDATE_CHECK_DELAY = 10_000
export const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000

export function startAppUpdateNotifications(): () => void {
  if (!updatesAvailable()) return () => {}
  let active = true
  let pending = false
  const notified = new Set<string>()

  async function check() {
    if (!active || pending) return
    pending = true
    let update: AvailableUpdate | null = null
    try {
      update = await checkAppUpdate()
      if (active && update && !notified.has(update.version)) {
        toast.info(
          `发现新版本 ${update.version}，前往「应用设置 → 关于 Nexus」即可更新。`,
          { duration: 12_000 },
        )
        notified.add(update.version)
      }
    } catch {
      // Manual checks show actionable errors; background checks retry quietly.
    } finally {
      await update?.close().catch(() => {})
      pending = false
    }
  }

  const initial = setTimeout(() => void check(), UPDATE_CHECK_DELAY)
  const interval = setInterval(() => void check(), UPDATE_CHECK_INTERVAL)
  return () => {
    active = false
    clearTimeout(initial)
    clearInterval(interval)
  }
}
