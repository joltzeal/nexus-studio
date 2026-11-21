import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AppearancePage } from '@/features/appearance/appearance-page'
import { AboutPage } from '@/features/about/about-page'
import { NetworkProxyPage } from '@/features/settings/network-proxy-page'
import { BrowserConnectionsPage } from './browser-connections-page'
import { ConfigurationPage } from './configuration-page'
import { LabPage } from './lab-page'

export function SettingsPage() {
  return (
    <Tabs defaultValue="browsers" orientation="vertical" className="grid h-full min-h-0 min-w-0 grid-cols-[176px_minmax(0,1fr)] gap-2 overflow-hidden max-[700px]:grid-cols-1 max-[700px]:grid-rows-[auto_minmax(0,1fr)]">
      <TabsList variant="navigation" aria-label="设置分类" className="!h-auto !w-44 !flex-none flex-col items-stretch justify-start gap-0.5 overflow-x-hidden overflow-y-auto rounded-xl bg-card p-2 max-[700px]:!h-12 max-[700px]:!w-full max-[700px]:!flex-row max-[700px]:items-center max-[700px]:overflow-x-auto max-[700px]:overflow-y-hidden [&_[data-slot=tabs-trigger]]:!h-8 [&_[data-slot=tabs-trigger]]:!w-full [&_[data-slot=tabs-trigger]]:!flex-none [&_[data-slot=tabs-trigger]]:justify-start [&_[data-slot=tabs-trigger]]:text-[13px] max-[700px]:[&_[data-slot=tabs-trigger]]:!w-auto">
        <TabsTrigger value="appearance">外观</TabsTrigger>
        <TabsTrigger value="browsers">浏览器接入</TabsTrigger>
        <TabsTrigger value="proxy">应用代理</TabsTrigger>
        <TabsTrigger value="configuration">配置迁移</TabsTrigger>
        <TabsTrigger value="lab">实验室</TabsTrigger>
        <TabsTrigger value="about">关于 Raccoon</TabsTrigger>
      </TabsList>
      <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl bg-card p-4 max-[700px]:p-3 [&>[data-slot=tabs-content]]:m-0 [&_.settings-page]:!m-0 [&_.settings-page]:!w-full [&_.settings-page]:!max-w-none [&_.settings-page>[data-slot=card]]:bg-transparent">
        <TabsContent value="appearance">
          <AppearancePage />
        </TabsContent>
        <TabsContent value="browsers">
          <BrowserConnectionsPage />
        </TabsContent>
        <TabsContent value="proxy">
          <NetworkProxyPage />
        </TabsContent>
        <TabsContent value="configuration">
          <ConfigurationPage />
        </TabsContent>
        <TabsContent value="lab">
          <LabPage />
        </TabsContent>
        <TabsContent value="about">
          <AboutPage />
        </TabsContent>
      </div>
    </Tabs>
  )
}
