import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { Input } from '@proxyshard/shardx-ui-kit'
import { HelperTools } from './HelperTools'

it('groups address and label tools and retains tool contents when switching categories', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <HelperTools
          address={<Input aria-label="地址资料" defaultValue="保留地址" />}
          labels={<p>label-A6.pdf</p>}
        />,
      ),
    )
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs.map((tab) => tab.textContent)).toEqual(['地址工具', '面单工具'])
    const address = container.querySelector<HTMLInputElement>('[aria-label="地址资料"]')!
    address.value = '尚未保存的地址'
    await act(async () => tabs[1].click())
    const labels = container.querySelector('[role="tabpanel"]:not(.hidden)')!
    expect(labels.textContent).toContain('label-A6.pdf')
    expect(labels.getAttribute('aria-labelledby')).toBe(tabs[1].id)
    await act(async () => tabs[0].click())
    expect(container.querySelector('[aria-label="地址资料"]')).toBe(address)
    expect(address.value).toBe('尚未保存的地址')
    await act(async () => tabs[1].click())
    expect(
      container.querySelector('[role="tabpanel"]:not(.hidden)')!.textContent,
    ).toContain('label-A6.pdf')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
