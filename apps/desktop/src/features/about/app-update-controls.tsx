import { Button } from '@/components/ui/button'
import type { AppUpdateSnapshot } from '@/lib/platform/app-update-controller'

function statusMessage(state: AppUpdateSnapshot): string | null {
  switch (state.phase) {
    case 'checking':
      return '正在检查更新…'
    case 'up-to-date':
      return '当前已是最新版本'
    case 'downloading':
      if (state.total && state.downloaded >= state.total) return '正在验证更新包…'
      return state.total
        ? `正在后台下载更新 ${Math.min(100, Math.round((state.downloaded / state.total) * 100))}%`
        : '正在后台下载更新…'
    case 'ready':
      return `新版 ${state.version} 已下载，更新后将重启应用。`
    case 'installing':
      return '正在安装更新，请稍候…'
    case 'installed':
      return state.error
        ? '更新已安装，请手动重新打开应用。'
        : '更新已安装，正在重启应用…'
    default:
      return null
  }
}

export function AppUpdateControls({
  state,
  onCheck,
  onInstall,
}: {
  state: AppUpdateSnapshot
  onCheck: () => void
  onInstall: () => void
}) {
  const busy =
    state.phase === 'checking' ||
    state.phase === 'downloading' ||
    state.phase === 'installing'
  const status = statusMessage(state)

  return (
    <div className="flex flex-col gap-2">
      <div className="about-row">
        <dt>应用更新</dt>
        <dd className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={busy || state.phase === 'ready' || state.phase === 'installed'}
            onClick={onCheck}
          >
            {busy ? '请稍候…' : '检查更新'}
          </Button>
          {state.phase === 'ready' ? <Button onClick={onInstall}>立即更新</Button> : null}
        </dd>
      </div>
      {status ? <p role="status">{status}</p> : null}
      {state.error ? (
        <p role="alert" className="text-destructive">
          {state.error.message}
        </p>
      ) : null}
    </div>
  )
}
