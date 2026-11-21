import { useEffect, useState, useSyncExternalStore } from 'react'
import { AlertCircle } from '@/components/icons'
import { getAppInfo, type AppInfo } from '@/lib/platform/app-info'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
        关于 Raccoon
      </h1>
      <Card>
        <CardHeader>
          <CardTitle>Raccoon</CardTitle>
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
            </dl>
          ) : (
            <Skeleton className="h-40 w-full" aria-label="正在读取应用信息" />
          )}
        </CardContent>
      </Card>
    </section>
  )
}
