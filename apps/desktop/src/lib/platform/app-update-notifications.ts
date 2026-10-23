import { toast } from '@/components/ui/toast'
import { AppUpdateError, updatesAvailable } from './app-updates'
import { appUpdateController, type AppUpdateController } from './app-update-controller'

export const UPDATE_CHECK_DELAY = 10_000
export const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000

export function startAppUpdateNotifications(
  controller: AppUpdateController = appUpdateController,
): () => void {
  if (!updatesAvailable()) return () => {}
  let active = true
  let notice: number | null = null
  let notifiedVersion: string | null = null
  let previousPhase = controller.getSnapshot().phase

  function dismissNotice() {
    if (notice !== null) toast.dismiss(notice)
    notice = null
  }

  function renderNotice() {
    if (!active) return
    const state = controller.getSnapshot()
    const retry = previousPhase === 'installing' && state.phase === 'ready'
    previousPhase = state.phase
    if (state.phase !== 'ready') {
      dismissNotice()
      return
    }
    if (state.version && (state.version !== notifiedVersion || retry)) {
      dismissNotice()
      const version = state.version
      notice = toast.info(`新版 ${version} 已下载，更新后将重启应用。`, {
        duration: 0,
        action: {
          label: '立即更新',
          onClick: () => {
            if (!active || controller.getSnapshot().version !== version) return
            void controller.install().catch((cause: unknown) => {
              if (active) {
                toast.error(
                  cause instanceof AppUpdateError
                    ? cause.message
                    : '安装更新失败，请重试。',
                )
              }
            })
          },
        },
      })
      notifiedVersion = version
    }
  }

  function check() {
    if (!active) return
    // Manual checks expose the shared error; automatic retries stay quiet.
    void controller.prepare().catch(() => {})
  }

  const unsubscribe = controller.subscribe(renderNotice)
  renderNotice()
  const initial = setTimeout(check, UPDATE_CHECK_DELAY)
  const interval = setInterval(check, UPDATE_CHECK_INTERVAL)
  return () => {
    if (!active) return
    active = false
    clearTimeout(initial)
    clearInterval(interval)
    unsubscribe()
    dismissNotice()
    controller.dispose()
  }
}
