import { useState } from 'react'
import { Button, EmptyState } from '@proxyshard/shardx-ui-kit'
import type { BrowserConnection, BrowserConnectionProbe } from '@nexus/contracts/browser'
import { nativeApi, nativeError } from './api'
import { workspace } from './store'
import { toast } from '../shared/model/toast'
import { NavBrowsersIcon, PlayIcon } from '../shared/icons'

export function useBitBrowserLauncher() {
  const [launching, setLaunching] = useState(false)
  const launch = async () => {
    if (launching) return false
    setLaunching(true)
    try {
      await nativeApi.call('browser_bitbrowser_launch')
      await workspace.refresh().catch(() => {})
      return true
    } catch (error) {
      await workspace.refresh().catch(() => {})
      toast.fail({ title: '启动比特浏览器失败', detail: nativeError(error) })
      return false
    } finally {
      setLaunching(false)
    }
  }
  return { launching, launch }
}

export function bitBrowserOffline(
  connection: BrowserConnection | undefined,
  probe: BrowserConnectionProbe | null,
  loading: boolean,
) {
  return connection?.providerId === 'bitbrowser' && !loading && !probe?.connected
}

export function BitBrowserGuide({
  variant = 'empty',
}: {
  variant?: 'empty' | 'settings'
}) {
  const { launching, launch } = useBitBrowserLauncher()
  const retry = () => {
    void workspace.refresh().catch(() => {})
  }
  const actions = (
    <>
      <Button
        variant="primary"
        mode="filled"
        size="xsmall"
        leftIcon={<PlayIcon className="size-3.5" />}
        isLoading={launching}
        onClick={() => void launch()}
      >
        打开比特浏览器
      </Button>
      <Button size="xsmall" mode="stroke" variant="neutral" onClick={retry}>
        重新检测
      </Button>
    </>
  )
  if (variant === 'settings') {
    return (
      <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-control bg-bg-weak-50">
          <NavBrowsersIcon className="size-4 text-primary-base" />
        </div>
        <div className="min-w-[180px] flex-1">
          <div className="text-ui text-text-strong-950">未检测到比特浏览器本地 API</div>
          <p className="m-0 mt-0.5 text-help text-text-sub-600">
            启动并登录比特浏览器后保持运行，配置会自动恢复。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
    )
  }
  return (
    <div role="status">
      <EmptyState
        icon={<NavBrowsersIcon className="size-[21px] text-primary-base" />}
        title="未检测到比特浏览器本地 API"
        hint="启动并登录比特浏览器后保持运行，配置会自动恢复。"
        actions={actions}
      />
    </div>
  )
}
