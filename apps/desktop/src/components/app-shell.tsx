import { lazy, Suspense, useState } from 'react'
import {
  AlertCircle,
  Blocks,
  ChevronDown,
  ChevronRight,
  Folders,
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
import { ProxyPoolRoute } from '@/features/proxy/proxy-pool-page'
import { AddressGeneratorRoute } from '@/features/addresses/address-page'
import { SharedSupplyRoute } from '@/features/supply/supply-page'
import { AiImageRoute } from '@/features/ai-image/ai-image-page'
import { AccountsRoute } from '@/features/accounts/accounts-page'
import { VintedMonitorRoute } from '@/features/vinted-monitor/vinted-monitor-page'

const SettingsPage = lazy(() =>
  import('@/features/settings/settings-page').then((module) => ({
    default: module.SettingsPage,
  })),
)

/**
 * Plugin pages are not top-level destinations: they sit under 插件中心 the same
 * way an installed extension sits inside its manager.
 */
const PLUGIN_PAGES = [
  { value: 'proxy', label: '代理池', icon: Network },
  { value: 'addresses', label: '地址生成器', icon: MapPinned },
  { value: 'supply', label: '共享货源', icon: ShoppingBag },
  { value: 'ai-image', label: 'AI 生图', icon: Sparkles },
  { value: 'accounts', label: 'Vinted 账号', icon: Users },
  { value: 'vinted', label: 'Vinted 监控', icon: Radar },
] as const

const PAGE_LABELS: Record<string, string> = {
  spaces: '窗口管理',
  groups: '分组管理',
  plugins: '插件中心',
  settings: '应用设置',
  ...Object.fromEntries(PLUGIN_PAGES.map((page) => [page.value, page.label])),
}

export function AppShell() {
  const [page, setPage] = useState('spaces')
  const [pluginsOpen, setPluginsOpen] = useState(true)
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
  const pluginPage = PLUGIN_PAGES.find((entry) => entry.value === page) ?? null

  function openPage(value: string) {
    setPage(value)
    if (value === 'plugins' || PLUGIN_PAGES.some((entry) => entry.value === value)) {
      setPluginsOpen(true)
    }
  }

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
            ? PLUGIN_PAGES.map((entry) => {
                const Icon = entry.icon
                return (
                  <TabsTrigger
                    key={entry.value}
                    value={entry.value}
                    data-depth="sub"
                    className="nav-sub-trigger"
                  >
                    <Icon />
                    {entry.label}
                  </TabsTrigger>
                )
              })
            : null}
          <TabsTrigger value="settings">
            <Settings2 />
            应用设置
          </TabsTrigger>
        </TabsList>
        <div className="sidebar-version">
          Nexus Studio <span>v0.1.0</span>
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
              <strong>{pluginPage.label}</strong>
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
            <TabsContent value="proxy">
              <ProxyPoolRoute />
            </TabsContent>
            <TabsContent value="addresses">
              <AddressGeneratorRoute />
            </TabsContent>
            <TabsContent value="supply">
              <SharedSupplyRoute />
            </TabsContent>
            <TabsContent value="ai-image">
              <AiImageRoute />
            </TabsContent>
            <TabsContent value="accounts">
              <AccountsRoute />
            </TabsContent>
            <TabsContent value="vinted">
              <VintedMonitorRoute />
            </TabsContent>
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

      <footer className="app-footer">
        <span>Nexus Studio</span>
      </footer>
    </Tabs>
  )
}
