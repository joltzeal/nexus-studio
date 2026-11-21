import { useCallback, useEffect, useState } from 'react'
import { Download, RefreshCw } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import {
  aliasDelete,
  aliasDownload,
  aliasJob,
  aliasLatest,
  aliasStatus,
  isAliasVersion,
  type AliasRelease,
  type AliasStatus,
  type AliasEngine,
  isAliasFirefoxVersion,
} from '@/lib/platform/aliasmode-kernels'
import {
  setManagedAliasMode,
  type BrowserConnection,
} from '@/lib/platform/browser-connections'
import { browserWindowsAvailable } from '@/lib/platform/windows'
import { Input } from '@/components/ui/input'
import { KernelDeleteButton } from './kernel-delete-button'

function errorText(cause: unknown): string {
  return typeof cause === 'string'
    ? cause
    : cause instanceof Error
      ? cause.message
      : '操作失败，请稍后重试'
}

export function AliasModeLab({
  engine,
  connection,
  ready,
  onConnectionChange,
}: {
  engine: AliasEngine
  connection: BrowserConnection | null
  ready: boolean
  onConnectionChange: (value: BrowserConnection) => void
}) {
  const native = browserWindowsAvailable()
  const [status, setStatus] = useState<AliasStatus | null>(null)
  const [release, setRelease] = useState<AliasRelease | null>(null)
  const [working, setWorking] = useState(false)
  const [version, setVersion] = useState('')
  const [error, setError] = useState<string | null>(null)
  const downloadActive = status?.download.phase === 'preparing'
    || status?.download.phase === 'downloading' || status?.download.phase === 'extracting'
  const busy = working || downloadActive

  const refresh = useCallback(async () => {
    if (!native) return
    try {
      setStatus(await aliasStatus(engine))
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [native, engine])
  useEffect(() => {
    if (!native) return
    let active = true
    void aliasStatus(engine).then(
      (value) => {
        if (!active) return
        setStatus(value)
        setRelease(null)
        setError(null)
      },
      (cause) => { if (active) setError(errorText(cause)) },
    )
    return () => { active = false }
  }, [native, engine])
  useEffect(() => {
    if (
      !working &&
      status?.download.phase !== 'preparing' &&
      status?.download.phase !== 'downloading' &&
      status?.download.phase !== 'extracting'
    )
      return
    const timer = setInterval(() => {
      void aliasJob(engine).then(
        (download) => {
          setStatus((current) => (current ? { ...current, download } : current))
          if (download.phase === 'ready') void refresh()
        },
        (cause) => setError(errorText(cause)),
      )
    }, 1000)
    return () => clearInterval(timer)
  }, [working, status?.download.phase, refresh, engine])

  async function run(action: () => Promise<unknown>) {
    if (busy) return
    setError(null)
    setWorking(true)
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(errorText(cause))
      await refresh()
    } finally {
      setWorking(false)
    }
  }

  const installed = status?.installed ?? []
  const supported = status?.platform !== 'unsupported'
  return (
    <section
      className="flex min-w-0 flex-col gap-4"
      aria-label={`AliasMode ${engine === 'firefox' ? 'Firefox' : 'Chromium'} 实验接入`}
    >
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-medium">AliasMode {engine === 'firefox' ? 'Firefox' : 'Chromium'}</h3>
        <Switch
          aria-label="启用 AliasMode"
          checked={connection?.enabled ?? false}
          disabled={!native || !ready || !supported || busy}
          onCheckedChange={(enabled) =>
            void run(async () => {
              const saved = await setManagedAliasMode(enabled)
              onConnectionChange(saved)
              window.dispatchEvent(new Event('raccoon:connections-change'))
            })
          }
        />
      </div>
      {!native ? (
        <p className="text-xs text-muted-foreground">请在桌面应用中管理内核。</p>
      ) : null}
      {status && !supported ? (
        <p className="text-xs text-muted-foreground">当前系统架构暂无官方发行包。</p>
      ) : null}
      {native && supported ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run(async () => setRelease(await aliasLatest(engine)))}
            >
              <RefreshCw data-icon="inline-start" />
              检查更新
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await aliasDownload(undefined, engine)
                })
              }
            >
              <Download data-icon="inline-start" />
              下载最新内核
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={working}
              onClick={() => void refresh()}
            >
              刷新本机列表
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="指定内核发行版本"
              placeholder={engine === 'firefox' ? 'aliasmode-runtime-156.0.1-beta.36-r14' : '155.0.8059.85-aliasmode.5'}
              className="min-w-64 flex-1"
              value={version}
              disabled={busy}
              onChange={(event) => setVersion(event.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !(engine === 'firefox' ? isAliasFirefoxVersion(version) : isAliasVersion(version))}
              onClick={() => void run(() => aliasDownload(version, engine))}
            >
              下载指定版本
            </Button>
          </div>
          {release ? (
            <p className="text-xs text-muted-foreground">官方版本：{release.version}</p>
          ) : null}
          <div className="flex flex-col gap-2 border-t pt-4">
            <h4 className="font-medium">已安装内核</h4>
            {installed.length ? (
              <div className="divide-y rounded-md border">
                {installed.map((kernel) => (
                  <div
                    key={kernel.version}
                    className="flex items-center justify-between gap-3 px-3 py-1.5"
                  >
                    <span className="min-w-0 truncate text-sm">{kernel.version}</span>
                    <KernelDeleteButton
                      version={kernel.version}
                      disabled={busy}
                      onDelete={async () => {
                        await aliasDelete(kernel.version, engine)
                        await refresh()
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">尚未安装内核</p>
            )}
          </div>
          {downloadActive && status ? (
            <div className="flex flex-col gap-1.5">
              <p role="status" className="text-xs text-muted-foreground">
                {status.download.phase === 'preparing' ? '正在准备' : status.download.phase === 'downloading' ? '下载中' : '正在校验并安装'}
                {status.download.phase === 'downloading' && status.download.percent !== null ? ` · ${status.download.percent}%` : ''}
              </p>
              <progress aria-label={`AliasMode ${engine === 'firefox' ? 'Firefox' : 'Chromium'} 内核下载进度`}
                max={100} value={status.download.phase === 'downloading' ? status.download.percent ?? undefined : undefined}
                className="h-1.5 w-full accent-primary" />
            </div>
          ) : null}
        </>
      ) : null}
      {error ? (
        <FieldError role="alert">{error}</FieldError>
      ) : status?.download.phase === 'failed' && status.download.error ? (
        <FieldError role="alert">{status.download.error}</FieldError>
      ) : null}
    </section>
  )
}
