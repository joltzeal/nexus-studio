import { useEffect, useRef, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  downloadKernel,
  checkLatestKernel,
  getKernelStatus,
  KernelOperationError,
  nativeKernelsAvailable,
  type KernelFailure,
  type KernelPhase,
  type KernelStatus,
  type KernelRelease,
} from '@/lib/platform/native-kernels'
import { kernelAvailability } from './kernel-release-state'

const phaseLabels: Record<KernelPhase, string> = {
  idle: '暂无下载任务',
  preparing: '正在准备',
  downloading: '正在下载',
  verifying: '正在校验',
  extracting: '正在解压',
  retrying: '正在重试',
  ready: '内核已就绪',
  failed: '下载失败',
}

function isActive(phase: KernelPhase | undefined): boolean {
  return (
    phase === 'preparing' ||
    phase === 'downloading' ||
    phase === 'verifying' ||
    phase === 'extracting' ||
    phase === 'retrying'
  )
}

function failure(cause: unknown): KernelFailure {
  return cause instanceof KernelOperationError
    ? cause
    : { code: 'unknown', message: '内核操作失败，请重试。', retryable: true }
}

function useKernelSettings(native: boolean) {
  const [status, setStatus] = useState<KernelStatus | null>(null)
  const [loading, setLoading] = useState(native)
  const [refreshing, setRefreshing] = useState(false)
  const [pending, setPending] = useState(false)
  const [statusError, setStatusError] = useState<KernelFailure | null>(null)
  const [downloadError, setDownloadError] = useState<KernelFailure | null>(null)
  const [completed, setCompleted] = useState<string | null>(null)
  const [release, setRelease] = useState<KernelRelease | null>(null)
  const [checking, setChecking] = useState(native)
  const [checkError, setCheckError] = useState<KernelFailure | null>(null)
  const actions = useRef<{
    refresh: () => void
    download: () => void
    check: () => void
  } | null>(null)

  useEffect(() => {
    if (!native) return
    let mounted = true
    let reading = false
    let queued = false
    let queuedRefresh = false
    let downloading = false
    let checkingRelease = false
    let latest: KernelStatus | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    async function check() {
      if (!mounted || checkingRelease) return
      checkingRelease = true
      setChecking(true)
      setCheckError(null)
      try {
        const result = await checkLatestKernel()
        if (mounted) setRelease(result)
      } catch (cause) {
        if (mounted) setCheckError(failure(cause))
      } finally {
        checkingRelease = false
        if (mounted) setChecking(false)
      }
    }

    function read(refresh = false) {
      if (!mounted) return
      clearTimeout(timer)
      timer = undefined
      if (refresh) setRefreshing(true)
      if (reading) {
        queued = true
        queuedRefresh ||= refresh
        return
      }
      reading = true
      void getKernelStatus(refresh)
        .then(
          (result) => {
            if (!mounted) return
            latest = result
            setStatus(result)
            setStatusError(null)
          },
          (cause: unknown) => {
            if (mounted) setStatusError(failure(cause))
          },
        )
        .finally(() => {
          if (!mounted) return
          reading = false
          setLoading(false)
          if (queued) {
            const refreshNext = queuedRefresh
            queued = false
            queuedRefresh = false
            read(refreshNext)
          } else {
            setRefreshing(false)
            // The command can still be pending while the first status is idle.
            if (downloading || isActive(latest?.download.phase)) {
              timer = setTimeout(() => read(), 900)
            }
          }
        })
    }

    async function download() {
      if (
        !mounted ||
        downloading ||
        checkingRelease ||
        !latest ||
        isActive(latest.download.phase) ||
        !latest.activationConfigured
      ) {
        return
      }
      downloading = true
      setPending(true)
      setDownloadError(null)
      setCompleted(null)
      const command = downloadKernel()
      read()
      try {
        const version = await command
        if (mounted) setCompleted(`内核 ${version} 已下载。`)
      } catch (cause) {
        if (mounted) setDownloadError(failure(cause))
      } finally {
        if (mounted) {
          downloading = false
          setPending(false)
          read(true)
          void check()
        }
      }
    }

    actions.current = {
      refresh: () => read(true),
      download: () => void download(),
      check: () => void check(),
    }
    read()
    void check()
    return () => {
      mounted = false
      clearTimeout(timer)
      actions.current = null
    }
  }, [native])

  return {
    status,
    loading,
    refreshing,
    pending,
    statusError,
    downloadError,
    completed,
    release,
    checking,
    checkError,
    refresh: () => actions.current?.refresh(),
    download: () => actions.current?.download(),
    check: () => actions.current?.check(),
  }
}

export function KernelSettingsPage() {
  const native = nativeKernelsAvailable()
  const view = useKernelSettings(native)
  const { status, pending } = view
  const download = status?.download
  const busy = view.loading || view.refreshing || pending || isActive(download?.phase)
  const availability =
    view.checkError || view.checking || view.statusError
      ? 'unknown'
      : kernelAvailability(view.release, status)
  const failed =
    view.downloadError ??
    (!pending && download?.phase === 'failed'
      ? (download.error ?? {
          code: 'download_failed',
          message: '内核下载失败，请重试。',
          retryable: true,
        })
      : null)
  const showProgress =
    download && !view.downloadError && (!pending || isActive(download.phase))
  const progress = showProgress
    ? [
        download.percent !== null ? `${download.percent}%` : null,
        download.downloadedMb !== null && download.totalMb !== null
          ? `${download.downloadedMb} / ${download.totalMb} MB`
          : download.downloadedMb !== null
            ? `已下载 ${download.downloadedMb} MB`
            : download.totalMb !== null
              ? `总计 ${download.totalMb} MB`
              : null,
        download.attempt !== null ? `第 ${download.attempt} 次尝试` : null,
        download.version ? `版本 ${download.version}` : null,
      ]
        .filter((part) => part !== null)
        .join(' · ')
    : ''
  const phase = view.downloadError
    ? '下载失败'
    : pending
      ? showProgress
        ? phaseLabels[download.phase]
        : '正在等待下载结果…'
      : download
        ? phaseLabels[download.phase]
        : null

  return (
    <section
      className="settings-page page-reveal min-w-0"
      aria-labelledby="kernel-heading"
    >
      <h1 className="page-heading" id="kernel-heading">
        浏览器内核
      </h1>
      <p className="page-description">下载内核保存在本机，已有窗口的内核保持不变。</p>
      {!native ? (
        <Alert>
          <AlertTitle>桌面应用专属</AlertTitle>
          <AlertDescription>请在桌面应用中管理和下载浏览器内核。</AlertDescription>
        </Alert>
      ) : (
        <>
          {view.statusError ? (
            <Alert variant="destructive">
              <AlertTitle>无法读取内核状态</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                <span>{view.statusError.message}</span>
                <Button
                  variant="outline"
                  disabled={view.loading || view.refreshing}
                  onClick={view.refresh}
                >
                  重试读取
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>内核更新</CardTitle>
              <CardDescription>切换页面后，下载仍会在桌面应用后台继续。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="m-0 font-medium">
                      {view.release
                        ? `${view.checkError || view.checking ? '上次查询版本' : '最新版本'} ${view.release.version}`
                        : '最新内核'}
                    </p>
                    {availability !== 'unknown' ? (
                      <Badge
                        variant={
                          availability === 'downloadable' ? 'secondary' : 'outline'
                        }
                      >
                        {availability === 'downloadable'
                          ? '可下载'
                          : availability === 'installed'
                            ? '已下载'
                            : '本机已有更新版本'}
                      </Badge>
                    ) : null}
                  </div>
                  <p
                    id="latest-kernel-description"
                    className="m-0 text-xs text-muted-foreground"
                  >
                    {status
                      ? status.activationConfigured
                        ? '使用已保存的激活码下载。'
                        : '请先在「激活码」页保存激活码。'
                      : '读取激活码状态后可下载。'}
                  </p>
                  <p className="m-0 text-xs text-muted-foreground">
                    {view.checking
                      ? '正在检查最新版本…'
                      : view.release
                        ? `${view.checkError ? '上次成功检查' : '检查时间'}：${new Date(view.release.checkedAt).toLocaleString()}`
                        : '尚未取得最新版本信息'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={busy || view.checking}
                    onClick={view.check}
                  >
                    <RefreshCw data-icon="inline-start" />
                    {view.checking ? '正在检查…' : '检查更新'}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || view.checking || !status?.activationConfigured}
                    aria-describedby="latest-kernel-description"
                    onClick={view.download}
                  >
                    <Download data-icon="inline-start" />
                    下载最新内核
                  </Button>
                </div>
              </div>
              {view.checkError ? (
                <Alert variant="destructive">
                  <AlertTitle>检查更新失败</AlertTitle>
                  <AlertDescription>{view.checkError.message}</AlertDescription>
                </Alert>
              ) : null}
              <div role="status" aria-live="polite" aria-atomic="true">
                <p className="m-0">
                  {(isActive(download?.phase) ? null : view.completed) ??
                    (view.loading ? '正在读取内核状态…' : phase)}
                </p>
                {progress ? (
                  <p className="m-0 text-xs text-muted-foreground">{progress}</p>
                ) : null}
              </div>
              {failed ? (
                <Alert variant="destructive">
                  <AlertTitle>下载失败</AlertTitle>
                  <AlertDescription className="flex flex-col items-start gap-2">
                    <span>{failed.message}</span>
                    {failed.retryable ? (
                      <Button
                        variant="outline"
                        disabled={busy || view.checking || !status?.activationConfigured}
                        onClick={view.download}
                      >
                        重试下载
                      </Button>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>已安装内核</CardTitle>
              <CardDescription>
                {status ? `平台：${status.platform}` : '读取本机内核列表。'}
              </CardDescription>
              <CardAction>
                <Button
                  variant="outline"
                  disabled={view.loading || view.refreshing}
                  onClick={view.refresh}
                >
                  <RefreshCw data-icon="inline-start" />
                  {view.refreshing ? '正在刷新…' : '刷新'}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-4">
              {!status ? (
                <p className="m-0 text-sm text-muted-foreground">
                  {view.loading ? '正在读取…' : '暂时无法读取已安装内核。'}
                </p>
              ) : (
                <>
                  {status.installed.length ? (
                    <Table aria-label="已安装的浏览器内核">
                      <TableHeader>
                        <TableRow>
                          <TableHead>版本</TableHead>
                          <TableHead>路径</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {status.installed.map((kernel) => (
                          <TableRow key={kernel.binaryPath}>
                            <TableCell>{kernel.version}</TableCell>
                            <TableCell>
                              <span className="block max-w-80 font-mono text-xs whitespace-normal break-all">
                                {kernel.binaryPath}
                              </span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <Empty className="p-4">
                      <EmptyHeader>
                        <EmptyTitle>尚未安装内核</EmptyTitle>
                        <EmptyDescription>
                          保存激活码后即可下载最新内核。
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )}
                  <dl className="m-0 flex flex-col gap-1">
                    <dt className="text-xs text-muted-foreground">缓存目录</dt>
                    <dd className="m-0 min-w-0 font-mono text-xs break-all">
                      {status.cacheDir}
                    </dd>
                  </dl>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </section>
  )
}
