import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { setAliasModeEnabled, useAliasModeEnabled } from './lab-preferences'

export function LabPage() {
  const aliasMode = useAliasModeEnabled()
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>AliasMode</CardTitle>
          <CardDescription>在窗口管理中显示 AliasMode 接入。</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3 text-sm">
          <span>实验性接入，需要本机已运行 AliasMode。</span>
          <Switch
            aria-label="启用 AliasMode"
            checked={aliasMode}
            onCheckedChange={setAliasModeEnabled}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Camoufox</CardTitle>
          <CardDescription>浏览器接入方案预留。</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">尚未接入。</CardContent>
      </Card>
    </div>
  )
}
