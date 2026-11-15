import { lazy, Suspense, useCallback, useEffect, useReducer, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  Blocks,
  Bot,
  ChevronDown,
  ChevronRight,
  Folders,
  KeyRound,
  LayoutGrid,
  MapPinned,
  Mail,
  Moon,
  Network,
  Package,
  Radar,
  RefreshCw,
  Settings2,
  ShoppingBag,
  Sparkles,
  Sun,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RetainedPage } from '@/components/retained-page'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { usePreferences } from '@/hooks/use-preferences'
import { SpacesPage } from '@/features/spaces/spaces-page'
import { GroupsPage } from '@/features/groups/groups-page'
import { AiImagePage } from '@/features/ai-image/ai-image-page'
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
import {
  cancelDetailNavigation,
  cancelUnavailableDetailNavigation,
  detailNavigationPage,
  pendingDetailNavigation,
  watchDetailNavigation,
  type DetailNavigationIntent,
} from '@/lib/detail-navigation'
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
  ['email.provider', Mail],
  ['product.catalog', Package],
  ['sales.agent', Bot],
])

const PAGE_LABELS: Record<string, string> = {
  spaces: '窗口管理',
  groups: '分组管理',
  plugins: '插件中心',
  settings: '应用设置',
}

export function AppShell() {
  const [
    { page, history, visitedPages, plugins, catalogLoaded, catalogError },
    navigate,
  ] = useReducer(pluginNavigationReducer, initialPluginNavigation)
  const [detailIntent, setDetailIntent] = useState<DetailNavigationIntent | null>(null)
  const [pluginsOpen, setPluginsOpen] = useState(true)
  // The shell keeps the editor payload until close, including in-place dialogs.
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
  const aiImagePlugin = plugins.find((plugin) => plugin.id === 'studio.ai-image') ?? null
  const aiImageReady = aiImagePlugin?.state === 'running'
  const dialogHandoff = aiImageHandoff?.presentation === 'dialog' ? aiImageHandoff : null
  const previousPage = history[history.length - 1]
  const previousPageName = previousPage?.startsWith('plugin:')
    ? plugins.find((entry) => pluginPageValue(entry.id) === previousPage)?.name
    : previousPage
      ? PAGE_LABELS[previousPage]
      : undefined
  const retained = { activePage: page, visitedPages }

  useEffect(() => {
    const stop = watchPluginCatalog(
      (catalog) => {
        reconcileSmsWaitPlugin(catalog)
        cancelUnavailableDetailNavigation(
          new Set([
            'spaces',
            ...catalog
              .filter((entry) => entry.enabled && entry.state !== 'available')
              .map((entry) => pluginPageValue(entry.id)),
          ]),
        )
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
    cancelDetailNavigation()
    setDetailIntent(null)
    navigate({ type: 'navigate', page: value })
    if (value === 'plugins' || value.startsWith('plugin:')) {
      setPluginsOpen(true)
    }
  }

  function goBack() {
    cancelDetailNavigation()
    setDetailIntent(null)
    navigate({ type: 'back' })
  }

  useEffect(
    () =>
      onAiImageHandoff((payload) => {
        setAiImageHandoff(payload)
        if (payload.presentation !== 'dialog') {
          cancelDetailNavigation()
          setDetailIntent(null)
          navigate({ type: 'navigate', page: pluginPageValue('studio.ai-image') })
          setPluginsOpen(true)
        }
      }),
    [],
  )

  const consumeAiImageHandoff = useCallback(() => setAiImageHandoff(null), [])

  useEffect(
    () =>
      watchDetailNavigation((request) => {
        const target = detailNavigationPage(request.kind)
        setDetailIntent(pendingDetailNavigation())
        navigate({ type: 'navigate', page: target, awaitCatalog: true })
        if (request.kind !== 'window') setPluginsOpen(true)
      }),
    [],
  )

  useEffect(() => {
    if (detailIntent && page !== detailNavigationPage(detailIntent.request.kind)) {
      cancelDetailNavigation(detailIntent.intentId)
    }
  }, [detailIntent, page])

  return (
    <Tabs
      value={page}
      onValueChange={openPage}
      orientation="vertical"
      className="app-shell"
    >
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <img
            className="brand-symbol"
            src="/raccoon.png"
            alt=""
            width={30}
            height={30}
          />
          <span className="wordmark">Raccoon</span>
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
          Raccoon <span>v{APP_VERSION}</span>
        </div>
      </aside>
      <header className="app-header">
        {previousPageName ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`返回${previousPageName}`}
            title={`返回${previousPageName}`}
            onClick={goBack}
          >
            <ArrowLeft data-icon="inline-start" />
            返回
          </Button>
        ) : null}
        <div className="header-breadcrumb">
          <span>工作区</span>
          <ChevronRight />
          {pluginPage === null ? (
            <strong>{PAGE_LABELS[page] ?? '正在读取插件'}</strong>
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
            {!catalogLoaded && page.startsWith('plugin:') ? (
              <Skeleton
                className="h-44 w-full max-w-lg"
                aria-label="正在读取目标插件"
                role="status"
              />
            ) : null}
            <RetainedPage value="spaces" {...retained}>
              <SpacesPage />
            </RetainedPage>
            <RetainedPage value="groups" {...retained}>
              <GroupsPage />
            </RetainedPage>
            <RetainedPage value="plugins" {...retained}>
              <PluginsPage />
            </RetainedPage>
            {plugins.map((plugin) => (
              <RetainedPage
                key={plugin.id}
                value={pluginPageValue(plugin.id)}
                {...retained}
              >
                <PluginPage
                  plugin={plugin}
                  hostAvailable
                  aiImageReady={aiImageReady}
                  handoff={dialogHandoff === null ? aiImageHandoff : null}
                  onHandoffConsumed={consumeAiImageHandoff}
                  onManage={() => openPage('plugins')}
                  onWindows={() => openPage('spaces')}
                />
              </RetainedPage>
            ))}
            <RetainedPage value="settings" {...retained}>
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
            </RetainedPage>
            {dialogHandoff === null ? null : (
              <AiImagePage
                plugin={aiImagePlugin}
                hostAvailable
                presentation="dialog"
                handoff={dialogHandoff}
                onHandoffConsumed={consumeAiImageHandoff}
              />
            )}
          </>
        )}
      </main>
    </Tabs>
  )
}
