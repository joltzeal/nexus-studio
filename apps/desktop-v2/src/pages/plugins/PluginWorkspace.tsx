import type { ReactNode } from 'react'
import { Card } from '@proxyshard/shardx-ui-kit'
import { PageBody } from '../../widgets/PageHeader'

export function PluginCard({
  children,
  scroll = false,
}: {
  children: ReactNode
  scroll?: boolean
}) {
  return (
    <Card
      padding="none"
      data-plugin-card
      className={`flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-3 has-[[data-list-header]]:[--tile-fill:var(--bg-tile)] [&_[data-list-tile]]:rounded-none! [&_[data-list-tile]]:bg-transparent! [&_[data-list-tile]]:shadow-none! ${scroll ? 'overflow-y-auto' : ''}`}
    >
      {children}
    </Card>
  )
}

export function PluginWorkspace({
  children,
  scroll,
}: {
  children: ReactNode
  scroll?: boolean
}) {
  return (
    <PageBody scroll={false}>
      <PluginCard scroll={scroll}>{children}</PluginCard>
    </PageBody>
  )
}
