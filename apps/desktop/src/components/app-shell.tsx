import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react'
import {
  AlertCircle,
  ArrowLeft,
  Blocks,
  BookMarked,
  Bot,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Clock3,
  Fingerprint,
  FolderPlus,
  Folders,
  Globe2,
  KeyRound,
  LayoutGrid,
  MapPinned,
  Mail,
  Moon,
  Network,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Radar,
  RefreshCw,
  Route,
  Search,
  Settings2,
  ShoppingBag,
  Sparkles,
  Sun,
  Trash2,
  Users,
  LifeBuoy,
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RetainedPage } from '@/components/retained-page'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { usePreferences } from '@/hooks/use-preferences'
import { SpacesPage } from '@/features/spaces/spaces-page'
import { GroupsPage } from '@/features/groups/groups-page'
import { AiImagePage } from '@/features/ai-image/ai-image-page'
import { startAutoProductImport } from '@/features/ai-image/auto-product-import-runtime'
import { PluginsPage } from '@/features/plugins/plugins-page'
import { PluginPage } from '@/features/plugins/plugin-page'
import {
  initialPluginNavigation,
  placeholderPages,
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
import {
  BROWSER_PROVIDERS,
  listBrowserConnections,
  type BrowserConnection,
  type BrowserProviderId,
} from '@/lib/platform/browser-connections'
import { setActiveBrowserSpace, useActiveBrowserSpace } from '@/lib/active-browser-space'
import { openExternalUrl } from '@/lib/platform/external-url'
import { browserWindowsAvailable } from '@/lib/platform/windows'
import { toast } from '@/components/ui/toast'

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

const browserSpaceIconPlaceholders: Record<BrowserProviderId, string> = {
  adspower: 'A',
  bitbrowser: 'B',
  cloakbrowser: 'C',
  aliasmode: 'A',
  shardbrowser: 'S',
}

function browserSpaceDescription(
  providerId: BrowserProviderId,
  connections: BrowserConnection[],
) {
  const kind = providerId === 'cloakbrowser' || providerId === 'aliasmode' || providerId === 'shardbrowser' ? '实验室' : '本地 API'
  const connection = connections.find(
    (item) => item.providerId === providerId && item.enabled,
  )
  if (connection?.scopeConfirmed) return `${kind} · 已启用`
  if (connection) return `${kind} · 待确认`
  return `${kind} · 未接入`
}

const PAGE_LABELS: Record<string, string> = {
  spaces: '全部配置',
  groups: '文件夹',
  plugins: '插件中心',
  settings: '设置',
  ...placeholderPages,
}

const navItem = 'h-7 w-full justify-start gap-2 rounded-lg px-2 text-[13px] font-normal text-muted-foreground hover:bg-(--shell-hover) hover:text-foreground data-[state=active]:bg-(--shell-hover) data-[state=active]:font-medium data-[state=active]:text-foreground focus-visible:!border-transparent focus-visible:!ring-0 focus-visible:!outline-none focus-visible:!shadow-none [&_svg]:size-4 group-data-[rail=true]/shell:justify-center group-data-[rail=true]/shell:px-0'

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[52px] shrink-0 items-center px-6"><h1 className="text-lg font-semibold">{title}</h1></div>
      <div className="grid flex-1 place-items-center px-6 pb-6">
        <div className="w-full max-w-md rounded-xl border bg-card px-6 py-8 text-center">
          <h2 className="text-base font-medium">{title}</h2>
          <p className="mt-2 text-sm text-muted-foreground">此功能尚未接入 Raccoon</p>
        </div>
      </div>
    </div>
  )
}

export function AppShell() {
  const [
    { page, history, visitedPages, plugins, catalogLoaded, catalogError },
    navigate,
  ] = useReducer(pluginNavigationReducer, initialPluginNavigation)
  const [detailIntent, setDetailIntent] = useState<DetailNavigationIntent | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [browserConnections, setBrowserConnections] = useState<BrowserConnection[]>([])
  const activeSpace = useActiveBrowserSpace()
  const activeProvider = BROWSER_PROVIDERS.find((entry) => entry.id === activeSpace)
  // The shell keeps the editor payload until close, including in-place dialogs.
  const [aiImageHandoff, setAiImageHandoff] = useState<AiImageHandoff | null>(null)
  const aiImageQueue = useRef<AiImageHandoff[]>([])
  const handoffSubmitted = useRef(false)
  const { loading, loadError, saveError, resolvedTheme, update, reload, retrySave } =
    usePreferences()
  const aiImagePlugin = plugins.find((plugin) => plugin.id === 'studio.ai-image') ?? null
  const proxyPlugin = plugins.find((plugin) => plugin.id === 'studio.proxy-pool') ?? null
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
    return startAutoProductImport()
  }, [])

  useEffect(() => {
    if (!browserWindowsAvailable()) return
    let active = true
    const refresh = () => {
      void listBrowserConnections().then(
        (items) => {
          if (active) setBrowserConnections(items)
        },
        () => {
          if (active) setBrowserConnections([])
        },
      )
    }
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener('raccoon:connections-change', refresh)
    return () => {
      active = false
      window.removeEventListener('focus', refresh)
      window.removeEventListener('raccoon:connections-change', refresh)
    }
  }, [])

  useEffect(() => {
    const stop = watchPluginCatalog(
      (catalog) => {
        reconcileSmsWaitPlugin(catalog)
        cancelUnavailableDetailNavigation(
          new Set([
            'spaces',
            ...catalog
              .filter(
                (entry) =>
                  entry.enabled &&
                  entry.state !== 'available' &&
                  entry.state !== 'unlicensed',
              )
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
  }

  function goBack() {
    cancelDetailNavigation()
    setDetailIntent(null)
    navigate({ type: 'back' })
  }

  useEffect(
    () =>
      onAiImageHandoff((payload) => {
        const { batch = [], ...first } = payload
        aiImageQueue.current = batch
        handoffSubmitted.current = false
        setAiImageHandoff(first)
        if (payload.presentation !== 'dialog') {
          cancelDetailNavigation()
          setDetailIntent(null)
          navigate({ type: 'navigate', page: pluginPageValue('studio.ai-image') })
        }
      }),
    [],
  )

  const consumeAiImageHandoff = useCallback(() => {
    const next = handoffSubmitted.current ? aiImageQueue.current.shift() : undefined
    handoffSubmitted.current = false
    if (!next) aiImageQueue.current = []
    setAiImageHandoff(next ?? null)
  }, [])
  const markAiImageSubmitted = useCallback(() => {
    handoffSubmitted.current = true
  }, [])

  useEffect(
    () =>
      watchDetailNavigation((request) => {
        const target = detailNavigationPage(request.kind)
        setDetailIntent(pendingDetailNavigation())
        navigate({ type: 'navigate', page: target, awaitCatalog: true })
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
      className="group/shell grid h-dvh min-h-0 grid-cols-[232px_minmax(0,1fr)] gap-2 overflow-hidden bg-(--shell-ground) p-2 data-[rail=true]:grid-cols-[56px_minmax(0,1fr)] max-[700px]:grid-cols-[56px_minmax(0,1fr)]"
      data-rail={sidebarCollapsed ? 'true' : undefined}
      onPointerDownCapture={(event) => { event.currentTarget.dataset.input = 'pointer' }}
      onKeyDownCapture={(event) => { event.currentTarget.dataset.input = 'keyboard' }}
    >
      <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-card">
        <div className="flex h-[52px] min-w-0 shrink-0 items-center gap-2 px-3 group-data-[rail=true]/shell:justify-center group-data-[rail=true]/shell:px-1 max-[700px]:justify-center max-[700px]:px-1">
          <img src="/raccoon.png" alt="" draggable={false} className="size-6 shrink-0 rounded-md object-cover group-data-[rail=true]/shell:hidden max-[700px]:hidden" />
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold group-data-[rail=true]/shell:hidden max-[700px]:hidden">Raccoon</span>
          <Button variant="ghost" size="icon-xs" className="!bg-transparent" aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} onClick={() => setSidebarCollapsed((value) => !value)}>{sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</Button>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="mx-2 mb-2 h-8 min-w-0 justify-start gap-2 px-2 text-[13px] font-medium group-data-[rail=true]/shell:mx-1 group-data-[rail=true]/shell:justify-center group-data-[rail=true]/shell:px-0 max-[700px]:mx-1 max-[700px]:justify-center max-[700px]:px-0" aria-label={`切换浏览器工作区，当前 ${activeProvider?.name ?? '浏览器'}`} title={activeProvider?.name}>
              <Users className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left group-data-[rail=true]/shell:hidden max-[700px]:hidden">{activeProvider?.name ?? '浏览器'}</span>
              <ChevronsUpDown className="size-3.5 text-muted-foreground group-data-[rail=true]/shell:hidden max-[700px]:hidden" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-56">
            <DropdownMenuLabel>浏览器工作区</DropdownMenuLabel>
            {BROWSER_PROVIDERS.filter((provider) => provider.id === 'adspower' || provider.id === 'bitbrowser' || browserConnections.some((item) => item.providerId === provider.id)).map((provider) => (
              <DropdownMenuItem key={provider.id} onSelect={() => setActiveBrowserSpace(provider.id)}>
                <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-xs">{browserSpaceIconPlaceholders[provider.id]}</span>
                <span className="min-w-0 flex-1 truncate">{provider.name}<small className="block text-muted-foreground">{browserSpaceDescription(provider.id, browserConnections)}</small></span>
                {activeSpace === provider.id && <Check className="size-3.5 text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col">
          <TabsList variant="navigation" aria-label="固定导航" className="!h-auto w-full min-w-0 flex-none flex-col items-stretch gap-0.5 px-2 pb-3 group-data-[rail=true]/shell:px-1 max-[700px]:px-1">
            <TabsTrigger value="search" className={navItem} title="搜索" aria-label="搜索"><Search /><span className="min-w-0 flex-1 text-left group-data-[rail=true]/shell:hidden">搜索</span></TabsTrigger>
            <TabsTrigger value="spaces" className={navItem} title="全部配置" aria-label="全部配置"><LayoutGrid /><span className="group-data-[rail=true]/shell:hidden">全部配置</span></TabsTrigger>
            <TabsTrigger value={proxyPlugin ? pluginPageValue(proxyPlugin.id) : 'proxy'} className={navItem} title="代理" aria-label="代理"><Network /><span className="group-data-[rail=true]/shell:hidden">代理</span></TabsTrigger>
            <TabsTrigger value="fingerprints" className={navItem} title="指纹" aria-label="指纹"><Fingerprint /><span className="group-data-[rail=true]/shell:hidden">指纹</span></TabsTrigger>
            <TabsTrigger value="extensions" className={navItem} title="扩展" aria-label="扩展"><Blocks /><span className="group-data-[rail=true]/shell:hidden">扩展</span></TabsTrigger>
            <TabsTrigger value="bookmarks" className={navItem} title="书签" aria-label="书签"><BookMarked /><span className="group-data-[rail=true]/shell:hidden">书签</span></TabsTrigger>
            <TabsTrigger value="automation" className={navItem} title="自动化" aria-label="自动化"><Route /><span className="group-data-[rail=true]/shell:hidden">自动化</span></TabsTrigger>
            <TabsTrigger value="proxyshard" className={navItem} title="ProxyShard" aria-label="ProxyShard"><ShoppingBag /><span className="group-data-[rail=true]/shell:hidden">ProxyShard</span></TabsTrigger>
          </TabsList>
          <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2 group-data-[rail=true]/shell:px-1 max-[700px]:px-1">
            <p className="flex h-8 items-center justify-between px-2 text-[11px] text-muted-foreground"><span className="group-data-[rail=true]/shell:hidden max-[700px]:hidden">文件夹</span><Folders className="size-3.5 group-data-[rail=true]/shell:hidden max-[700px]:hidden" /></p>
            <TabsList variant="navigation" aria-label="文件夹" className="!h-auto w-full flex-col items-stretch gap-0.5"><TabsTrigger value="groups" className={navItem} title="分组管理" aria-label="分组管理"><FolderPlus /><span className="group-data-[rail=true]/shell:hidden">分组管理</span></TabsTrigger></TabsList>
            <p className="flex h-8 items-center px-2 text-[11px] text-muted-foreground"><span className="group-data-[rail=true]/shell:hidden max-[700px]:hidden">视图</span><ChevronDown className="ml-1 size-3 group-data-[rail=true]/shell:hidden max-[700px]:hidden" /></p>
            <TabsList variant="navigation" aria-label="视图" className="!h-auto w-full flex-col items-stretch gap-0.5">
              <TabsTrigger value="running" className={navItem} title="运行中" aria-label="运行中"><Play /><span className="group-data-[rail=true]/shell:hidden">运行中</span></TabsTrigger>
              <TabsTrigger value="direct" className={navItem} title="无代理" aria-label="无代理"><Globe2 /><span className="group-data-[rail=true]/shell:hidden">无代理</span></TabsTrigger>
              <TabsTrigger value="recent" className={navItem} title="最近使用" aria-label="最近使用"><Clock3 /><span className="group-data-[rail=true]/shell:hidden">最近使用</span></TabsTrigger>
            </TabsList>
            <p className="flex h-8 items-center px-2 text-[11px] text-muted-foreground group-data-[rail=true]/shell:hidden max-[700px]:hidden">插件</p>
            <TabsList variant="navigation" aria-label="已启用插件" className="!h-auto w-full flex-col items-stretch gap-0.5">
              <TabsTrigger value="plugins" className={navItem} title="插件中心" aria-label="插件中心"><Package /><span className="group-data-[rail=true]/shell:hidden">插件中心</span></TabsTrigger>
              {plugins.filter((entry) => entry.id !== 'studio.proxy-pool').map((entry) => { const Icon = capabilityIcons.get(entry.capabilities[0] ?? '') ?? Blocks; return <TabsTrigger key={entry.id} value={pluginPageValue(entry.id)} className={navItem} title={entry.name} aria-label={entry.name}><Icon /><span className="truncate group-data-[rail=true]/shell:hidden">{entry.name}</span></TabsTrigger> })}
            </TabsList>
            {catalogError && <Button variant="ghost" size="sm" onClick={notifyPluginCatalogChanged}><RefreshCw data-icon="inline-start" />重新读取插件</Button>}
          </div>
        </nav>
        <div className="flex min-w-0 shrink-0 flex-col gap-0.5 p-2 group-data-[rail=true]/shell:px-1 max-[700px]:px-1">
          <TabsList variant="navigation" aria-label="底部导航" className="!h-auto w-full flex-col items-stretch gap-0.5">
            <TabsTrigger value="recycle" className={navItem} title="回收站" aria-label="回收站"><Trash2 /><span className="group-data-[rail=true]/shell:hidden">回收站</span></TabsTrigger>
            <TabsTrigger value="settings" className={navItem} title="设置" aria-label="设置"><Settings2 /><span className="group-data-[rail=true]/shell:hidden">设置</span></TabsTrigger>
          </TabsList>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="h-7 w-full justify-start gap-2 px-2 text-[12px] font-normal text-muted-foreground group-data-[rail=true]/shell:justify-center group-data-[rail=true]/shell:px-0 max-[700px]:justify-center max-[700px]:px-0" title="支持" aria-label="支持"><LifeBuoy className="size-4" /><span className="group-data-[rail=true]/shell:hidden max-[700px]:hidden">Raccoon v{APP_VERSION}</span></Button></DropdownMenuTrigger><DropdownMenuContent side="right"><DropdownMenuLabel>Raccoon v{APP_VERSION}</DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void openExternalUrl('https://github.com/joltzeal/nexus-studio/issues').catch(() => toast.error('无法打开支持页面'))}>打开支持页面</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
          <div className="mt-1 flex items-center gap-2 border-t px-2 pt-2 text-[11px] text-muted-foreground group-data-[rail=true]/shell:justify-center group-data-[rail=true]/shell:px-0 max-[700px]:justify-center max-[700px]:px-0"><span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" /><span className="truncate group-data-[rail=true]/shell:hidden max-[700px]:hidden">{browserSpaceDescription(activeSpace, browserConnections)}</span></div>
        </div>
      </aside>
      <main className="relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-background [&>[data-slot=tabs-content]]:min-h-0 [&>[data-slot=tabs-content]]:min-w-0 [&>[data-slot=tabs-content]]:overflow-x-hidden [&>[data-slot=tabs-content]]:overflow-y-auto [&>[data-slot=tabs-content]]:overscroll-contain [&>[data-slot=tabs-content]]:p-0">
        {page !== 'spaces' ? <div className="absolute right-5 top-3 z-10 flex gap-2">
          {previousPageName ? <Button variant="ghost" size="icon-sm" aria-label={`返回${previousPageName}`} onClick={goBack}><ArrowLeft /></Button> : null}
          <Button variant="ghost" size="icon-sm" aria-label={resolvedTheme === 'dark' ? '切换为浅色' : '切换为深色'} disabled={loading || !!loadError} onClick={() => void update({ theme: resolvedTheme === 'dark' ? 'light' : 'dark' })}>{resolvedTheme === 'dark' ? <Moon /> : <Sun />}</Button>
        </div> : null}
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
            <RetainedPage value="spaces" {...retained}><SpacesPage /></RetainedPage>
            <RetainedPage value="groups" {...retained}>
              <div className="p-5"><GroupsPage /></div>
            </RetainedPage>
            <RetainedPage value="plugins" {...retained}>
              <div className="p-5"><PluginsPage /></div>
            </RetainedPage>
            {Object.entries(placeholderPages).map(([value, title]) => (
              <RetainedPage key={value} value={value} {...retained}><PlaceholderPage title={title} /></RetainedPage>
            ))}
            {plugins.map((plugin) => (
              <RetainedPage
                key={plugin.id}
                value={pluginPageValue(plugin.id)}
                {...retained}
              >
                <div className="p-5"><PluginPage
                  plugin={plugin}
                  hostAvailable
                  aiImageReady={aiImageReady}
                  handoff={dialogHandoff === null ? aiImageHandoff : null}
                  onHandoffConsumed={consumeAiImageHandoff}
                  onManage={() => openPage('plugins')}
                  onWindows={() => openPage('spaces')}
                /></div>
              </RetainedPage>
            ))}
            <RetainedPage value="settings" {...retained}>
              <div className="h-full p-5"><Suspense
                fallback={
                  <Skeleton
                    className="h-44 w-full max-w-lg"
                    aria-label="正在加载设置"
                    role="status"
                  />
                }
              >
                <SettingsPage />
              </Suspense></div>
            </RetainedPage>
            {dialogHandoff === null ? null : (
              <AiImagePage
                plugin={aiImagePlugin}
                hostAvailable
                presentation="dialog"
                handoff={dialogHandoff}
                onHandoffConsumed={consumeAiImageHandoff}
                onHandoffSubmitted={markAiImageSubmitted}
              />
            )}
          </>
        )}
      </main>
    </Tabs>
  )
}
