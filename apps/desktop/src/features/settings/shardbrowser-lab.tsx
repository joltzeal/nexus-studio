import { useCallback, useEffect, useState } from 'react'
import { Download, RefreshCw } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { setManagedShardBrowser, type BrowserConnection } from '@/lib/platform/browser-connections'
import { shardDelete, shardDownload, shardStatus, type ShardStatus } from '@/lib/platform/shardbrowser-kernels'
import { browserWindowsAvailable } from '@/lib/platform/windows'
import { KernelDeleteButton } from './kernel-delete-button'

export function ShardBrowserLab({
  connection, ready, onConnectionChange,
}: {
  connection: BrowserConnection | null
  ready: boolean
  onConnectionChange: (value: BrowserConnection) => void
}) {
  const native = browserWindowsAvailable()
  const [status, setStatus] = useState<ShardStatus | null>(null)
  const [pending, setPending] = useState(false)
  const [downloadPending, setDownloadPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    if (!native) return
    try { setStatus(await shardStatus()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '读取内核失败') }
  }, [native])
  useEffect(() => {
    if (!native) return
    let active = true
    void shardStatus().then(
      (value) => { if (active) setStatus(value) },
      (cause) => { if (active) setError(cause instanceof Error ? cause.message : '读取内核失败') },
    )
    return () => { active = false }
  }, [native])
  useEffect(() => {
    if (!status?.downloading && !downloadPending) return
    const timer = setInterval(() => { void refresh() }, 1500)
    return () => clearInterval(timer)
  }, [status?.downloading, downloadPending, refresh])

  const download = status?.download
  const phaseLabels = {
    idle: '等待下载开始', preparing: '正在准备', downloading: '正在下载',
    extracting: '正在解压', verifying: '正在校验', ready: '内核已安装', failed: '下载失败',
  }

  async function run(operation: () => Promise<unknown>) {
    if (pending) return
    setPending(true)
    setError(null)
    try { await operation(); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); await refresh() }
    finally { setPending(false) }
  }

  return <section className="flex min-w-0 flex-col gap-4" aria-label="ShardBrowser 实验接入">
    <div className="flex items-center justify-between gap-4 border-b pb-3">
      <h3 className="font-medium">ShardBrowser</h3>
      <Switch aria-label="启用 ShardBrowser 接入" checked={connection?.enabled ?? false}
        disabled={!native || !ready || pending || status?.platform !== 'supported'}
        onCheckedChange={(enabled) => void run(async () => {
          const saved = await setManagedShardBrowser(enabled)
          onConnectionChange(saved)
          window.dispatchEvent(new Event('raccoon:connections-change'))
        })} />
    </div>
    {native && status?.platform === 'unsupported' ? <p className="text-xs text-muted-foreground">当前系统架构不受支持。</p> : null}
    {native && status?.platform === 'supported' ? <>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={pending || status.downloading}
          onClick={() => void run(async () => {
            setDownloadPending(true)
            try { await shardDownload() }
            finally { setDownloadPending(false) }
          })}>
          <Download data-icon="inline-start" />{status.downloading || downloadPending ? '正在下载…' : '下载最新内核'}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => void refresh()}>
          <RefreshCw data-icon="inline-start" />刷新本机列表
        </Button>
      </div>
      {status.downloading || downloadPending ? <div className="flex flex-col gap-1.5">
        <p role="status" className="text-xs text-muted-foreground">
          {status.downloading && download ? phaseLabels[download.phase] : '正在等待下载结果'}
          {status.downloading && download?.label ? ` · ${download.label}` : ''}
          {status.downloading && download?.phase === 'downloading' && download.percent !== null ? ` · ${Math.round(download.percent)}%` : ''}
        </p>
        <progress aria-label="ShardBrowser 内核下载进度" max={100}
          value={status.downloading && download?.phase === 'downloading' ? download.percent ?? undefined : undefined}
          className="h-1.5 w-full accent-primary" />
        {status.downloading && download?.phase === 'downloading' ? <p className="text-xs tabular-nums text-muted-foreground">
          {(download.receivedBytes / 1024 / 1024).toFixed(1)} MiB
          {download.totalBytes !== null ? ` / ${(download.totalBytes / 1024 / 1024).toFixed(1)} MiB` : ' · 总大小未知'}
        </p> : null}
      </div> : null}
      <div className="flex flex-col gap-2 border-t pt-4">
        <h4 className="font-medium">已安装内核</h4>
        <div className="divide-y rounded-md border">
          {status.installed.map((item) => <div key={item.version} className="flex items-center justify-between gap-3 px-3 py-1.5">
            <span className="text-sm">{item.version}</span>
            <KernelDeleteButton version={item.version} disabled={pending || status.downloading} onDelete={async () => { await shardDelete(item.version); await refresh() }} />
          </div>)}
          {!status.installed.length ? <p className="px-3 py-2 text-sm text-muted-foreground">暂无已安装内核</p> : null}
        </div>
      </div>
    </> : null}
    {error || (!downloadPending && download?.error) ? <FieldError role="alert">{error ?? download?.error}</FieldError> : null}
  </section>
}
