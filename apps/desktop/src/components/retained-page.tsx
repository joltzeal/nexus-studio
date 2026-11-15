import { Activity, type ReactNode } from 'react'
import { TabsContent } from '@/components/ui/tabs'

export function RetainedPage({
  value,
  activePage,
  visitedPages,
  children,
}: {
  value: string
  activePage: string
  visitedPages: readonly string[]
  children: ReactNode
}) {
  if (!visitedPages.includes(value)) return null
  return (
    <Activity mode={activePage === value ? 'visible' : 'hidden'}>
      <TabsContent value={value} forceMount>
        {children}
      </TabsContent>
    </Activity>
  )
}
