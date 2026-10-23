import { useEffect, useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { getAppInfo, type AppInfo } from '@/lib/platform/app-info'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import {
  checkAppUpdate,
  installAppUpdate,
  updatesAvailable,
  AppUpdateError,
  type AvailableUpdate,
} from '@/lib/platform/app-updates'

export function AboutPage() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [failed, setFailed] = useState(false)
  const [update, setUpdate] = useState<AvailableUpdate | null>(null)
  const [updateStatus, setUpdateStatus] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [updatePending, setUpdatePending] = useState(false)
  const mounted = useRef(true)

  async function checkUpdate() {
    setUpdatePending(true)
    setUpdateError(null)
    setUpdateStatus(null)
    setUpdate(null)
    try {
      const available = await checkAppUpdate()
      if (!mounted.current) {
        await available?.close().catch(() => {})
        return
      }
      setUpdate(available)
      setUpdateStatus(available ? `发现新版本 ${available.version}` : '当前已是最新版本')
    } catch (cause) {
      setUpdateError(
        cause instanceof AppUpdateError ? cause.message : '检查更新失败，请重试。',
      )
    } finally {
      setUpdatePending(false)
    }
  }

  async function installUpdate() {
    if (!update) return
    setUpdatePending(true)
    setUpdateError(null)
    setUpdateStatus('正在下载更新…')
    try {
      await installAppUpdate(update, (downloaded, total) => {
        setUpdateStatus(
          total
            ? `正在下载更新 ${Math.min(100, Math.round((downloaded / total) * 100))}%`
            : '正在下载更新…',
        )
      })
    } catch (cause) {
      setUpdateStatus(null)
      if (cause instanceof AppUpdateError && cause.code === 'relaunch_failed') {
        setUpdate(null)
        setUpdateStatus('更新已安装，请手动重新打开应用。')
      }
      setUpdateError(
        cause instanceof AppUpdateError ? cause.message : '安装更新失败，请重试。',
      )
    } finally {
      setUpdatePending(false)
    }
  }

  useEffect(() => {
    let active = true
    mounted.current = true
    void getAppInfo().then(
      (result) => {
        if (active) setInfo(result)
      },
      () => {
        if (active) setFailed(true)
      },
    )
    return () => {
      active = false
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    return () => {
      void update?.close().catch(() => {})
    }
  }, [update])

  return (
    <section className="settings-page page-reveal" aria-labelledby="about-heading">
      <h1 className="page-heading" id="about-heading">
        关于 Nexus
      </h1>
      <p className="page-description">多账户浏览器环境管理工作区。</p>
      <Card>
        <CardHeader>
          <CardTitle>Nexus Studio</CardTitle>
          <CardDescription>多账户窗口管理应用。</CardDescription>
        </CardHeader>
        <CardContent>
          {failed ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>
                暂时无法读取应用信息，请重新打开此页面。
              </AlertDescription>
            </Alert>
          ) : info ? (
            <dl className="about-details">
              <div className="about-row">
                <dt>应用版本</dt>
                <dd>{info.version}</dd>
              </div>
              {updatesAvailable() ? (
                <>
                  <Separator />
                  <div className="about-row">
                    <dt>应用更新</dt>
                    <dd className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        disabled={updatePending}
                        onClick={() => void checkUpdate()}
                      >
                        {updatePending ? '请稍候…' : '检查更新'}
                      </Button>
                      {update ? (
                        <Button
                          disabled={updatePending}
                          onClick={() => void installUpdate()}
                        >
                          安装 {update.version}
                        </Button>
                      ) : null}
                    </dd>
                  </div>
                  {updateStatus ? <p role="status">{updateStatus}</p> : null}
                  {updateError ? (
                    <p role="alert" className="text-destructive">
                      {updateError}
                    </p>
                  ) : null}
                </>
              ) : null}
              <Separator />
              <div className="about-row">
                <dt>运行方式</dt>
                <dd>桌面端原生窗口 / 网页预览</dd>
              </div>
              <div className="about-row">
                <dt>偏好存储</dt>
                <dd>当前 WebView / 浏览器</dd>
              </div>
              <div className="about-row">
                <dt>窗口数据</dt>
                <dd>桌面端保存为独立窗口；网页预览不可创建</dd>
              </div>
            </dl>
          ) : (
            <Skeleton className="h-40 w-full" aria-label="正在读取应用信息" />
          )}
        </CardContent>
        <CardFooter>
          <p className="m-0 text-sm text-muted-foreground">
            激活码和窗口配置保存在本机数据库；受信任插件由独立进程运行。
          </p>
        </CardFooter>
      </Card>
    </section>
  )
}
