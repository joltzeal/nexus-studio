import { lazy, Suspense, useCallback, useEffect, useReducer, useState } from 'react'
import {
  AlertCircle,
  Blocks,
  ChevronDown,
  ChevronRight,
  Folders,
  KeyRound,
  LayoutGrid,
  MapPinned,
  Moon,
  Network,
  Radar,
  RefreshCw,
  Settings2,
  ShoppingBag,
  Sparkles,
  Sun,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { usePreferences } from '@/hooks/use-preferences'
import { SpacesPage } from '@/features/spaces/spaces-page'
import { GroupsPage } from '@/features/groups/groups-page'
import { PluginsPage } from '@/features/plugins/plugins-page'
import { PluginPage } from '@/features/plugins/plugin-page'
import {
  initialPluginNavigation,
  pluginNavigationReducer,
  pluginPageValue,
} from '@/features/plugins/plugin-navigation'
import { watchPluginCatalog } from '@/features/plugins/watch-plugin-catalog'
import {
  disposeSmsWaits,
  reconcileSmsWaitPlugin,
} from '@/features/accounts/sms-wait-runtime'
import { onAiImageHandoff, type AiImageHandoff } from '@/lib/page-handoff'
import { APP_VERSION } from '@/lib/platform/app-info'
import { notifyPluginCatalogChanged } from '@/lib/platform/plugin-catalog-events'

const SettingsPage = lazy(() =>
  import('@/features/settings/settings-page').then((module) => ({
    default: module.SettingsPage,
  })),
)

const capabilityIcons = new Map([
  ['proxy.provider', Network],
  ['address.generator', MapPinned],
  ['supply.catalog', ShoppingBag],
  ['image.provider', Sparkles],
  ['account.pool', Users],
  ['verification.provider', KeyRound],
  ['monitor.collector', Radar],
])

const PAGE_LABELS: Record<string, string> = {
  spaces: '窗口管理',
  groups: '分组管理',
  plugins: '插件中心',
  settings: '应用设置',
}

export function AppShell() {
  const [{ page, plugins, catalogError }, navigate] = useReducer(
    pluginNavigationReducer,
    initialPluginNavigation,
  )
  const [pluginsOpen, setPluginsOpen] = useState(true)
  // A page can hand pictures to the AI page; the payload is kept here so it
  // survives the switch and is dropped once the dialog has taken it.
  const [aiImageHandoff, setAiImageHandoff] = useState<AiImageHandoff | null>(null)
  const {
    loading,
    loadError,
    saveError,
    resolvedTheme,
    preferences,
    update,
    reload,
    retrySave,
  } = usePreferences()
  const nextTheme = resolvedTheme === 'dark' ? 'light' : 'dark'
  const themeAction = nextTheme === 'dark' ? '切换为深色' : '切换为浅色'
  const pluginPage = plugins.find((entry) => pluginPageValue(entry.id) === page) ?? null
  const aiImageReady = plugins.some(
    (plugin) => plugin.id === 'studio.ai-image' && plugin.state === 'running',
  )

  useEffect(() => {
    const stop = watchPluginCatalog(
      (catalog) => {
        reconcileSmsWaitPlugin(catalog)
        navigate({ type: 'catalog', plugins: catalog })
      },
      () => navigate({ type: 'error' }),
    )
    window.addEventListener('focus', notifyPluginCatalogChanged)
    return () => {
      stop()
      disposeSmsWaits()
      window.removeEventListener('focus', notifyPluginCatalogChanged)
    }
  }, [])

  function openPage(value: string) {
    navigate({ type: 'navigate', page: value })
    if (value === 'plugins' || value.startsWith('plugin:')) {
      setPluginsOpen(true)
    }
  }

  useEffect(
    () =>
      onAiImageHandoff((payload) => {
        setAiImageHandoff(payload)
        navigate({ type: 'navigate', page: pluginPageValue('studio.ai-image') })
        setPluginsOpen(true)
      }),
    [],
  )

  const consumeAiImageHandoff = useCallback(() => setAiImageHandoff(null), [])

  return (
    <Tabs
      value={page}
      onValueChange={openPage}
      orientation="vertical"
      className="app-shell"
    >
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <span className="brand-symbol">N</span>
          <span className="wordmark">
            Nexus<span className="wordmark-dot">.</span>
          </span>
        </div>
        <div className="workspace-switcher">
          <span className="workspace-avatar">
            {preferences.workspaceName.slice(0, 1)}
          </span>
          <div>
            <strong>{preferences.workspaceName}</strong>
            <small>本地工作区</small>
          </div>
        </div>
        <span className="nav-caption">工作区</span>
        <TabsList variant="navigation" aria-label="主导航" className="sidebar-nav">
          <TabsTrigger value="spaces">
            <LayoutGrid />
            窗口管理
          </TabsTrigger>
          <TabsTrigger value="groups">
            <Folders />
            分组管理
          </TabsTrigger>
          <TabsTrigger value="plugins" className="nav-group-trigger">
            <Blocks />
            插件中心
            <span
              className="nav-group-toggle"
              role="presentation"
              data-open={pluginsOpen ? 'true' : undefined}
              onPointerDown={(event) => {
                // Radix activates a tab on mousedown, so the fold has to be
                // decided here: the row navigates, only the chevron folds.
                event.preventDefault()
                event.stopPropagation()
                setPluginsOpen((open) => !open)
              }}
            >
              <ChevronDown />
            </span>
          </TabsTrigger>
          {pluginsOpen
            ? plugins.map((entry) => {
                const Icon = capabilityIcons.get(entry.capabilities[0] ?? '') ?? Blocks
                return (
                  <TabsTrigger
                    key={entry.id}
                    value={pluginPageValue(entry.id)}
                    data-depth="sub"
                    className="nav-sub-trigger"
                    title={entry.name}
                  >
                    <Icon />
                    <span className="truncate">{entry.name}</span>
                  </TabsTrigger>
                )
              })
            : null}
          <TabsTrigger value="settings">
            <Settings2 />
            应用设置
          </TabsTrigger>
        </TabsList>
        {catalogError ? (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={notifyPluginCatalogChanged}
          >
            <RefreshCw data-icon="inline-start" />
            重新读取插件列表
          </Button>
        ) : null}
        <div className="sidebar-version">
          Nexus Studio <span>v{APP_VERSION}</span>
        </div>
      </aside>
      <header className="app-header">
        <div className="header-breadcrumb">
          <span>工作区</span>
          <ChevronRight />
          {pluginPage === null ? (
            <strong>{PAGE_LABELS[page]}</strong>
          ) : (
            <>
              <span>插件中心</span>
              <ChevronRight />
              <strong>{pluginPage.name}</strong>
            </>
          )}
        </div>
        <div className="header-actions">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={themeAction}
                disabled={loading || !!loadError}
                onClick={() => void update({ theme: nextTheme })}
              >
                {resolvedTheme === 'dark' ? <Moon /> : <Sun />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{themeAction}</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <main className="app-main">
        {loading ? (
          <div className="shell-loading" aria-label="正在读取偏好" role="status">
            <Skeleton className="h-44 w-full max-w-lg" />
          </div>
        ) : loadError ? (
          <Alert variant="destructive" className="page-alert">
            <AlertCircle />
            <AlertTitle>暂时无法打开本地偏好</AlertTitle>
            <AlertDescription>
              <p>{loadError}</p>
              <Button variant="outline" onClick={reload}>
                <RefreshCw data-icon="inline-start" />
                重新读取
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {saveError ? (
              <Alert variant="destructive" className="page-alert">
                <AlertCircle />
                <AlertTitle>这次调整还没有保存</AlertTitle>
                <AlertDescription>
                  <p>{saveError}</p>
                  <Button variant="outline" onClick={() => void retrySave()}>
                    重新保存
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            <TabsContent value="spaces">
              <SpacesPage />
            </TabsContent>
            <TabsContent value="groups">
              <GroupsPage />
            </TabsContent>
            <TabsContent value="plugins">
              <PluginsPage />
            </TabsContent>
            {plugins.map((plugin) => (
              <TabsContent key={plugin.id} value={pluginPageValue(plugin.id)}>
                <PluginPage
                  plugin={plugin}
                  hostAvailable
                  aiImageReady={aiImageReady}
                  handoff={aiImageHandoff}
                  onHandoffConsumed={consumeAiImageHandoff}
                  onManage={() => openPage('plugins')}
                  onWindows={() => openPage('spaces')}
                />
              </TabsContent>
            ))}
            <TabsContent value="settings">
              <Suspense
                fallback={
                  <Skeleton
                    className="h-44 w-full max-w-lg"
                    aria-label="正在加载设置"
                    role="status"
                  />
                }
              >
                <SettingsPage />
              </Suspense>
            </TabsContent>
          </>
        )}
      </main>
    </Tabs>
  )
}
