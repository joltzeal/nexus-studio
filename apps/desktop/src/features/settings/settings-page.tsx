import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AppearancePage } from '@/features/appearance/appearance-page'
import { WorkspacePage } from '@/features/workspace/workspace-page'
import { AboutPage } from '@/features/about/about-page'
import { LicenseSettingsPage } from '@/features/settings/license-settings-page'
import { NetworkProxyPage } from '@/features/settings/network-proxy-page'

export function SettingsPage() {
  return (
    <Tabs defaultValue="appearance" className="settings-tabs">
      <TabsList variant="line" aria-label="设置分类">
        <TabsTrigger value="appearance">外观</TabsTrigger>
        <TabsTrigger value="workspace">工作区</TabsTrigger>
        <TabsTrigger value="license">激活码</TabsTrigger>
        <TabsTrigger value="proxy">应用代理</TabsTrigger>
        <TabsTrigger value="about">关于 Nexus</TabsTrigger>
      </TabsList>
      <TabsContent value="appearance">
        <AppearancePage />
      </TabsContent>
      <TabsContent value="workspace">
        <WorkspacePage />
      </TabsContent>
      <TabsContent value="license">
        <LicenseSettingsPage />
      </TabsContent>
      <TabsContent value="proxy">
        <NetworkProxyPage />
      </TabsContent>
      <TabsContent value="about">
        <AboutPage />
      </TabsContent>
    </Tabs>
  )
}
