import { lazy, Suspense, useState } from 'react'
import {
  AlertCircle,
  Blocks,
  ChevronRight,
  Folders,
  LayoutGrid,
  MapPinned,
  Moon,
  Network,
  RefreshCw,
  Settings2,
  Sun,
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

const SettingsPage = lazy(() =>
  import('@/features/settings/settings-page').then((module) => ({
    default: module.SettingsPage,
  })),
)

export function AppShell() {
  const [page, setPage] = useState('spaces')
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

  return (
    <Tabs
      value={page}
      onValueChange={setPage}
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
        <TabsList variant="navigation" aria-label="主导航">
          <TabsTrigger value="spaces">
            <LayoutGrid />
            窗口管理
          </TabsTrigger>
          <TabsTrigger value="groups">
            <Folders />
            分组管理
          </TabsTrigger>
          <TabsTrigger value="plugins">
            <Blocks />
            插件中心
          </TabsTrigger>
          <TabsTrigger value="proxy">
            <Network />
            代理池
          </TabsTrigger>
          <TabsTrigger value="addresses">
            <MapPinned />
            地址生成器
          </TabsTrigger>
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
          <strong>
            {
              {
                spaces: '窗口管理',
                groups: '分组管理',
                plugins: '插件中心',
                proxy: '代理池',
                addresses: '地址生成器',
                settings: '应用设置',
              }[page]
            }
          </strong>
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
        <span>窗口的浏览器环境保存在本机</span>
        <span>Nexus Studio</span>
      </footer>
    </Tabs>
  )
}
