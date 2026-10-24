import { useCallback, useEffect, useState } from 'react'
import { Network } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { FieldError } from '@/components/ui/field'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  listPlugins,
  pluginHostAvailable,
  type PluginView,
} from '@/lib/platform/native-plugins'
import { PluginGate } from '@/features/plugins/plugin-gate'
import { VintedItemsTable } from './items-table'
import { MonitorListView } from './monitor-list'
import { ProxySettingsSheet } from './proxy-settings-sheet'
import { VINTED_PLUGIN_ID, message } from './types'

export interface VintedMonitorPageProps {
  plugin: PluginView | null
  hostAvailable: boolean
  aiImageReady?: boolean
}

export function VintedMonitorPage({
  plugin,
  hostAvailable,
  aiImageReady = false,
}: VintedMonitorPageProps) {
  const available =
    hostAvailable && plugin !== null && plugin.enabled && plugin.state === 'running'
  const modern =
    !!plugin?.methods.includes('vinted.items.get') &&
    !!plugin.methods.includes('vinted.proxies.list')
  const [view, setView] = useState('monitors')
  const [itemsFor, setItemsFor] = useState('')
  const [configuring, setConfiguring] = useState(false)
  const [revision, setRevision] = useState(0)
  return (
    <section
      className="collection-page page-reveal vinted-viewport"
      aria-labelledby="vinted-heading"
    >
      <Card className="vinted-shell">
        <div className="vinted-shell-head">
          <h1 id="vinted-heading" className="page-heading">
            Vinted 监控
          </h1>
          <Button
            size="sm"
            variant="outline"
            disabled={!available || !modern}
            onClick={() => setConfiguring(true)}
          >
            <Network data-icon="inline-start" />
            采集代理
          </Button>
        </div>
        {available ? (
          <>
            {!modern ? (
              <Alert className="m-3 w-auto">
                <AlertDescription>
                  请更新 Vinted 监控插件后使用独立代理、商品表格和 AI 生图联动。
                </AlertDescription>
              </Alert>
            ) : (
              <Tabs value={view} onValueChange={setView} className="min-h-0 flex-1 gap-0">
                <div className="vinted-toolbar">
                  <TabsList variant="line" aria-label="Vinted 功能">
                    <TabsTrigger value="monitors">URL 监控</TabsTrigger>
                    <TabsTrigger value="items" disabled={!modern}>
                      商品表格
                    </TabsTrigger>
                  </TabsList>
                </div>
                <TabsContent
                  value="monitors"
                  className="min-h-0 flex-col data-[state=active]:flex"
                >
                  <MonitorListView
                    refreshKey={revision}
                    modern={modern}
                    onConfigureProxies={() => setConfiguring(true)}
                    onItems={(id) => {
                      setItemsFor(id)
                      setView('items')
                    }}
                  />
                </TabsContent>
                <TabsContent
                  value="items"
                  className="min-h-0 flex-col data-[state=active]:flex"
                >
                  <VintedItemsTable
                    key={itemsFor}
                    initialMonitorId={itemsFor}
                    aiImageReady={aiImageReady}
                    refreshKey={revision}
                  />
                </TabsContent>
              </Tabs>
            )}
          </>
        ) : (
          <div className="vinted-body">
            <PluginGate
              label="Vinted 监控"
              plugin={plugin}
              hostAvailable={hostAvailable}
            />
          </div>
        )}
      </Card>
      {available && configuring ? (
        <ProxySettingsSheet
          onOpenChange={setConfiguring}
          onChanged={() => setRevision((value) => value + 1)}
        />
      ) : null}
    </section>
  )
}

export function VintedMonitorRoute() {
  const hostAvailable = pluginHostAvailable()
  const [plugin, setPlugin] = useState<PluginView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!hostAvailable) return
    try {
      const catalog = await listPlugins()
      setPlugin(catalog.find((entry) => entry.id === VINTED_PLUGIN_ID) ?? null)
    } catch (cause) {
      setError(message(cause))
    }
  }, [hostAvailable])

  useEffect(() => {
    if (!hostAvailable) return
    let active = true
    void listPlugins().then(
      (catalog) => {
        if (active) {
          setPlugin(catalog.find((entry) => entry.id === VINTED_PLUGIN_ID) ?? null)
        }
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [hostAvailable])

  // The host has no push channel: keep looking while the process is coming up.
  const pending = plugin === null || plugin.state !== 'running'
  useEffect(() => {
    if (!hostAvailable || !pending) return
    const timer = setInterval(() => {
      void refresh()
    }, 2000)
    return () => clearInterval(timer)
  }, [hostAvailable, pending, refresh])

  return (
    <>
      {error === null ? null : <FieldError role="alert">{error}</FieldError>}
      <VintedMonitorPage plugin={plugin} hostAvailable={hostAvailable} />
    </>
  )
}
