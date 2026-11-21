import { Button, IconButton } from '@proxyshard/shardx-ui-kit'
import { usePluginCatalog } from './catalog'
import { navigateDetail } from './detail-navigation'
import { PluginNavigationIcon } from './PluginNavigationIcon'
import { isNativeRaccoon } from '../runtime'

export function AgentHistoryAction({
  kind,
  id,
  compact = false,
  beforeOpen,
}: {
  kind: 'product' | 'account' | 'window'
  id: string
  compact?: boolean
  beforeOpen?: () => void
}) {
  const plugin = usePluginCatalog((state) =>
    state.plugins.find((item) => item.id === 'studio.sales-agent'),
  )
  if (!isNativeRaccoon() || !plugin?.enabled || plugin.state === 'available') return null
  const icon = <PluginNavigationIcon plugin={plugin} className="size-3.5" />
  const onClick = () => {
    beforeOpen?.()
    navigateDetail({ kind: 'agent', id, related: kind })
  }
  return compact ? (
    <IconButton
      label="查看 Ecom Agent 运行记录"
      size="3xsmall"
      variant="neutral"
      mode="ghost"
      icon={icon}
      onClick={onClick}
    />
  ) : (
    <Button
      size="xsmall"
      variant="neutral"
      mode="stroke"
      leftIcon={icon}
      onClick={onClick}
    >
      查看 Ecom Agent 运行记录
    </Button>
  )
}
