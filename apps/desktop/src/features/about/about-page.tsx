import { useEffect, useState, useSyncExternalStore } from 'react'
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
import { updatesAvailable } from '@/lib/platform/app-updates'
import { appUpdateController } from '@/lib/platform/app-update-controller'
import { AppUpdateControls } from './app-update-controls'

export function AboutPage() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [failed, setFailed] = useState(false)
  const update = useSyncExternalStore(
    appUpdateController.subscribe,
    appUpdateController.getSnapshot,
    appUpdateController.getSnapshot,
  )

  useEffect(() => {
    let active = true
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
    }
  }, [])

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
                  <AppUpdateControls
                    state={update}
                    onCheck={() => void appUpdateController.prepare().catch(() => {})}
                    onInstall={() => void appUpdateController.install().catch(() => {})}
                  />
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
