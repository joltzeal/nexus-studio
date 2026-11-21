import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  listBrowserConnections,
  setManagedCloakBrowser,
  type BrowserConnection,
} from '@/lib/platform/browser-connections'
import { browserError } from '@/lib/platform/browser-api'
import { browserWindowsAvailable } from '@/lib/platform/windows'
import { LicenseSettingsPage } from './license-settings-page'
import { KernelSettingsPage } from './kernel-settings-page'
import { AliasModeLab } from './aliasmode-lab'
import { ShardBrowserLab } from './shardbrowser-lab'

export function LabPage() {
  const native = browserWindowsAvailable()
  const [connection, setConnection] = useState<BrowserConnection | null>(null)
  const [aliasConnection, setAliasConnection] = useState<BrowserConnection | null>(null)
  const [shardConnection, setShardConnection] = useState<BrowserConnection | null>(null)
  const [loading, setLoading] = useState(native)
  const [loaded, setLoaded] = useState(false)
  const [reload, setReload] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!native) return
    let active = true
    void listBrowserConnections()
      .then(
        (items) => {
          if (active) {
            setConnection(
              items.find((item) => item.providerId === 'cloakbrowser') ?? null,
            )
            setAliasConnection(
              items.find((item) => item.providerId === 'aliasmode') ?? null,
            )
            setShardConnection(
              items.find((item) => item.providerId === 'shardbrowser') ?? null,
            )
            setLoaded(true)
            setError(null)
          }
        },
        (cause: unknown) => {
          if (active) {
            setLoaded(false)
            setError(browserError(cause).message)
          }
        },
      )
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [native, reload])

  async function toggle(enabled: boolean) {
    if (pending || !loaded) return
    setPending(true)
    setError(null)
    try {
      const saved = await setManagedCloakBrowser(enabled)
      setConnection(saved)
      window.dispatchEvent(new Event('raccoon:connections-change'))
    } catch (cause) {
      setError(browserError(cause).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="settings-page flex min-w-0 flex-col gap-4" aria-label="实验室">
      <div className="section-intro">
        <div>
          <h2 className="page-heading">实验室</h2>
        </div>
      </div>
      {error ? (
        <div className="flex items-center gap-3">
          <FieldError role="alert">{error}</FieldError>
          {!loaded && native ? (
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => {
                setLoading(true)
                setReload((value) => value + 1)
              }}
            >
              重试
            </Button>
          ) : null}
        </div>
      ) : null}
      <Tabs defaultValue="cloakbrowser" className="min-w-0 gap-5">
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="cloakbrowser">CloakBrowser</TabsTrigger>
          <TabsTrigger value="aliasmode">AliasMode</TabsTrigger>
          <TabsTrigger value="shardbrowser">ShardBrowser</TabsTrigger>
          <TabsTrigger value="camoufox">Camoufox</TabsTrigger>
        </TabsList>
        <TabsContent value="cloakbrowser" className="min-w-0">
          <section className="flex flex-col gap-5" aria-label="CloakBrowser 实验接入">
            <div className="flex items-center justify-between gap-4 border-b pb-3">
              <h3 className="font-medium">CloakBrowser</h3>
              <Switch
                aria-label="启用 CloakBrowser 接入"
                checked={connection?.enabled ?? false}
                disabled={!native || !loaded || loading || pending}
                onCheckedChange={(checked) => void toggle(checked)}
              />
            </div>
            {!native ? (
              <p className="text-sm text-muted-foreground">
                请在桌面应用中管理实验接入。
              </p>
            ) : null}
            {connection?.enabled ? (
              <div className="flex min-w-0 flex-col gap-6">
                <LicenseSettingsPage />
                <KernelSettingsPage />
              </div>
            ) : null}
          </section>
        </TabsContent>
        <TabsContent value="aliasmode" className="min-w-0">
          <Tabs defaultValue="chromium" className="min-w-0 gap-4">
            <TabsList><TabsTrigger value="chromium">Chromium</TabsTrigger><TabsTrigger value="firefox">Firefox</TabsTrigger></TabsList>
            {(['chromium', 'firefox'] as const).map((engine) => (
              <TabsContent key={engine} value={engine} className="min-w-0">
                <AliasModeLab engine={engine} connection={aliasConnection} ready={loaded} onConnectionChange={setAliasConnection} />
              </TabsContent>
            ))}
          </Tabs>
        </TabsContent>
        <TabsContent value="camoufox">
          <section aria-label="Camoufox 实验接入">
            <h3 className="font-medium">Camoufox</h3>
            <p className="text-sm text-muted-foreground">未接入</p>
          </section>
        </TabsContent>
        <TabsContent value="shardbrowser" className="min-w-0">
          <ShardBrowserLab connection={shardConnection} ready={loaded} onConnectionChange={setShardConnection} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
