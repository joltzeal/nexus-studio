import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import { proxyPoolApi } from '../../../raccoon/plugins/proxy-pool/api'
import { proxySiteApi } from '../../../raccoon/plugins/proxy-pool/providers'
import type { ProxyRow } from '../../../raccoon/plugins/proxy-pool/model'
import type { PluginView } from '../../../raccoon/plugins/types'
import { poolProxyChoice } from '../../../raccoon/profile-proxy'
import { ProxyChoiceList, usePoolProxyLabel } from './ProxyChoiceList'

vi.mock('../../../raccoon/store', () => ({ useWorkspace: () => ({}) }))
vi.mock('../../../raccoon/runtime', () => ({ isNativeRaccoon: () => true }))
vi.mock('../../../raccoon/plugins/proxy-pool/api', () => ({
  proxyPoolApi: { list: vi.fn(), groups: vi.fn(), get: vi.fn() },
}))
vi.mock('../../../raccoon/plugins/proxy-pool/providers', () => ({
  proxySiteApi: { subscriptions: vi.fn() },
}))

const plugin: PluginView = {
  id: 'studio.proxy-pool',
  name: '代理池',
  version: '1.0.5',
  apiVersion: 1,
  minCoreVersion: '0.1.35',
  capabilities: ['proxy.provider'],
  granted: ['proxy.provider'],
  permissions: {
    networkDomains: [],
    wantsBrowserAccess: false,
    storage: 'private',
    secrets: [],
  },
  source: 'workspace',
  state: 'running',
  enabled: true,
  methods: ['proxy.list', 'proxy.get', 'proxy.resolve', 'proxy.groups.list'],
  status: null,
  lastError: null,
  storageDurable: true,
  secretSlots: [],
  sourceDirectory: null,
  runtimeGeneration: 'first',
}

const endpoint: ProxyRow = {
  id: '109',
  name: '巴黎住宅',
  groupId: '1',
  schemes: ['socks5'],
  host: 'proxy.example.test',
  port: 1080,
  username: '',
  enabled: true,
  udp: false,
  hasPassword: true,
  checkStatus: 'ok',
  checkedScheme: 'socks5',
  checkedAt: null,
  exitIp: null,
  previousExitIp: null,
  previousExitIpCheckedAt: null,
  exitIpChanged: false,
  latencyMs: 128,
  checkError: null,
  geo: null,
  reputation: {
    status: 'ok',
    risk: 12,
    proxy: null,
    vpn: null,
    hosting: null,
    networkType: '住宅',
    provider: 'Decodo',
    asn: null,
    error: null,
  },
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.resetAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  usePluginCatalog.setState({ plugins: [plugin] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.mocked(proxyPoolApi.groups).mockResolvedValue([
    { id: 1, name: '欧洲组', createdAt: '' },
  ])
  vi.mocked(proxyPoolApi.list).mockImplementation(async ({ limit, offset }) => ({
    items:
      offset === 0
        ? [{ ...endpoint, id: '110', name: '伦敦节点', enabled: false }]
        : [endpoint],
    total: 101,
    limit,
    offset,
  }))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function click(selector: string, text: string) {
  const node = [...container.querySelectorAll<HTMLElement>(selector)].find((item) =>
    item.textContent?.includes(text),
  )
  expect(node).toBeDefined()
  await act(async () => node!.click())
}

it('keeps native entries at the top level and loads the pool only after drilling in', async () => {
  const onChange = vi.fn()
  await act(async () =>
    root.render(
      <ProxyChoiceList
        label="代理"
        options={[{ value: 'native', label: '香港办公' }]}
        allowPool
        value={null}
        onChange={onChange}
      />,
    ),
  )
  expect(container.textContent).not.toContain('直连')
  expect(proxyPoolApi.list).not.toHaveBeenCalled()
  expect(container.querySelector('button')?.textContent).toBe('代理池')
  await click('[role="option"]', '香港办公')
  expect(onChange).toHaveBeenCalledWith('native')
  const input = container.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      '香港',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('button', '代理池')
  expect(proxyPoolApi.list).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('欧洲组 · Decodo')
  expect(container.textContent).toContain('128 ms')
  expect(container.textContent).toContain('风险 12/100')
  await click('[role="option"]', '伦敦节点')
  expect(onChange).toHaveBeenCalledTimes(1)
  await click('[role="option"]', '巴黎住宅')
  expect(onChange).toHaveBeenLastCalledWith(poolProxyChoice(109))
  await click('button[aria-label="返回代理列表"]', '代理池')
  expect(container.querySelector('[aria-label="搜索代理池"]')).toBeNull()
  expect(container.querySelector('input')).toBe(input)
  expect(input.value).toBe('香港')
})

it('retries the pool independently of the native choices', async () => {
  vi.mocked(proxyPoolApi.list).mockRejectedValueOnce(new Error('unavailable'))
  const onChange = vi.fn()
  await act(async () =>
    root.render(
      <ProxyChoiceList
        label="代理"
        options={[]}
        allowPool
        value={null}
        onChange={onChange}
      />,
    ),
  )
  await click('button', '代理池')
  expect(container.textContent).toContain('代理池读取失败')
  await click('button', '重试')
  await click('[role="option"]', '巴黎住宅')
  expect(onChange.mock.calls).toEqual([[poolProxyChoice(109)]])
})

it('keeps the original binding label when the endpoint or plugin is unavailable', async () => {
  function BoundProxy() {
    return <span>{usePoolProxyLabel(poolProxyChoice(109))}</span>
  }
  vi.mocked(proxyPoolApi.get).mockRejectedValue(new Error('missing'))
  await act(async () => root.render(<BoundProxy />))
  expect(container.textContent).toBe('代理池 / #109（端点不可用）')
  await act(async () =>
    usePluginCatalog.setState({ plugins: [{ ...plugin, enabled: false }] }),
  )
  expect(container.textContent).toBe('代理池 / #109（插件不可用）')
})

it('does not show the submenu for an unsupported browser connection', async () => {
  await act(async () =>
    root.render(
      <ProxyChoiceList
        label="代理"
        options={[]}
        allowPool={false}
        value={null}
        onChange={vi.fn()}
      />,
    ),
  )
  expect(container.querySelector('button')).toBeNull()
  expect(proxyPoolApi.list).not.toHaveBeenCalled()
})

it('keeps native and plugin selections together in multiple mode', async () => {
  function MultiplePicker() {
    const [selected, setSelected] = useState<string[]>([])
    return (
      <>
        <ProxyChoiceList
          label="代理"
          options={[{ value: 'native', label: '香港办公' }]}
          allowPool
          multiple
          value={selected}
          onChange={(id, checked) =>
            setSelected((values) =>
              checked ? [...values, id] : values.filter((value) => value !== id),
            )
          }
        />
        <output>{selected.length}</output>
      </>
    )
  }
  await act(async () => root.render(<MultiplePicker />))
  await click('[role="option"]', '香港办公')
  await click('button', '代理池')
  await click('[role="option"]', '巴黎住宅')
  expect(container.querySelector('output')?.textContent).toBe('2')
  await click('button[aria-label="返回代理列表"]', '代理池')
  expect(
    container.querySelector('[role="option"][aria-selected="true"]')?.textContent,
  ).toBe('香港办公')
})

it('identifies Decodo manual-subscription endpoints in the Profile proxy picker', async () => {
  const subscriptionId = '9784c74b-fcbc-46d9-b65d-f74dbdbb0dfc'
  vi.mocked(proxyPoolApi.list).mockResolvedValue({
    items: [
      {
        ...endpoint,
        id: '110',
        name: 'ISP 01',
        origin: {
          accountId: '23d4283e-3867-445e-b54e-ba78240ab051',
          subscriptionId,
        },
      },
    ],
    total: 1,
    limit: 100,
    offset: 0,
  })
  vi.mocked(proxySiteApi.subscriptions).mockResolvedValue([
    {
      id: subscriptionId,
      accountId: '23d4283e-3867-445e-b54e-ba78240ab051',
      providerId: 'decodo',
      name: 'Decodo ISP · Office',
      productType: 'isp',
      source: 'manual',
      expiresAt: '2026-12-22T00:00:00.000Z',
      createdAt: '',
      updatedAt: '',
      enabled: true,
      expired: false,
      memberCount: 1,
    },
  ])
  await act(async () =>
    usePluginCatalog.setState({
      plugins: [
        {
          ...plugin,
          methods: [...plugin.methods, 'proxy.providerSubscriptions.list'],
        },
      ],
    }),
  )
  await act(async () =>
    root.render(
      <ProxyChoiceList
        label="代理"
        options={[]}
        allowPool
        value={null}
        onChange={vi.fn()}
      />,
    ),
  )
  await click('button', '代理池')
  await vi.waitFor(() => expect(container.textContent).toContain('Decodo ISP · Office'))
})
