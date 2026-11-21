import { useState, type ReactNode } from 'react'
import { TabPanel, Tabs } from '@proxyshard/shardx-ui-kit'
import { BuildingIcon, DocsIcon } from '../../../shared/icons'

export function HelperTools({
  address,
  labels,
}: {
  address: ReactNode
  labels: ReactNode
}) {
  const [tool, setTool] = useState('address')
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row md:gap-6">
      <Tabs
        idBase="vinted-helper-tools"
        aria-label="VInted helper 工具分类"
        orientation="vertical"
        className="shrink-0 md:w-36"
        value={tool}
        onChange={setTool}
        items={[
          { value: 'address', label: '地址工具', icon: <BuildingIcon /> },
          { value: 'labels', label: '面单工具', icon: <DocsIcon /> },
        ]}
      />
      <TabPanel
        tabsId="vinted-helper-tools"
        value="address"
        className={tool === 'address' ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}
      >
        {address}
      </TabPanel>
      <TabPanel
        tabsId="vinted-helper-tools"
        value="labels"
        className={tool === 'labels' ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}
      >
        {labels}
      </TabPanel>
    </div>
  )
}
