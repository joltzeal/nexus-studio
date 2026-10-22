import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import type { PluginView } from '@/lib/platform/native-plugins'

export interface PluginGateProps {
  /** What the page needs, e.g. 共享货源. */
  label: string
  hostAvailable: boolean
  plugin: PluginView | null
}

/**
 * One shared placeholder for a feature page whose plugin is not serving yet.
 * There is no enable or restart action: the host starts installed plugins on
 * boot and restarts them on its own, so the page only reports the wait.
 */
export function PluginGate({ label, hostAvailable, plugin }: PluginGateProps) {
  if (!hostAvailable) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{label}需要桌面应用</EmptyTitle>
          <EmptyDescription>插件宿主只在桌面应用中运行。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (plugin === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{label}插件尚未安装</EmptyTitle>
          <EmptyDescription>到插件中心安装后即可使用。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{label}插件正在启动</EmptyTitle>
        <EmptyDescription>
          {plugin.state === 'retrying'
            ? '进程未能启动，后台会自动重试。'
            : '进程就绪后自动加载。'}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
