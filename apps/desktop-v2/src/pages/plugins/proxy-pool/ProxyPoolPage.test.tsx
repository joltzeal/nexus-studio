import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { proxyPoolApi } from '../../../raccoon/plugins/proxy-pool/api'
import { PROXY_POOL_PAGE_METHODS } from '../../../raccoon/plugins/proxy-pool/page-contract'
import { PROXY_PLUGIN_ID, type ProxyRow } from '../../../raccoon/plugins/proxy-pool/model'
import { ProxyPoolPage } from './index'

vi.mock('../../../raccoon/runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../raccoon/runtime')>(),
  isNativeRaccoon: () => true,
}))
vi.mock('../../../raccoon/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../raccoon/api')>(),
  nativeApi: { call: async () => [] },
}))
vi.mock('../../../raccoon/plugins/catalog', () => ({
  usePluginCatalog: (select: (state: { plugins: unknown[] }) => unknown) => select({
    plugins: [{ id: PROXY_PLUGIN_ID, state: 'running', enabled: true, methods: [...PROXY_POOL_PAGE_METHODS, 'proxy.get'] }],
  }),
}))
vi.mock('../../../raccoon/plugins/proxy-pool/api', () => ({
  proxyPoolApi: { list: vi.fn(), groups: vi.fn(), config: vi.fn(), get: vi.fn(), check: vi.fn() },
}))

const endpoint: ProxyRow = {
  id: '1', name: '代理一', host: 'pool.example.test', port: 8080, schemes: ['http'],
  username: 'fixture', enabled: true, udp: false, hasPassword: true, groupId: null,
  checkStatus: 'unknown', checkedScheme: null, checkedAt: null, exitIp: null,
  previousExitIp: null, previousExitIpCheckedAt: null, exitIpChanged: false,
  geo: null, reputation: null, latencyMs: null, checkError: null,
}
let rows: ProxyRow[]
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.resetAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400)
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800)
  rows = [endpoint, { ...endpoint, id: '2', name: '代理二' }, { ...endpoint, id: '3', name: '暂停代理', enabled: false }]
  vi.mocked(proxyPoolApi.list).mockImplementation(async (query) => ({ items: rows.slice(), total: rows.length, limit: query.limit, offset: query.offset }))
  vi.mocked(proxyPoolApi.groups).mockResolvedValue([])
  vi.mocked(proxyPoolApi.config).mockResolvedValue({ defaultEndpointId: '1', risk: { enabled: true, cacheSeconds: 3600, hasApiKey: false } })
  vi.mocked(proxyPoolApi.get).mockImplementation(async (id) => rows.find((row) => row.id === String(id))!)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function clickButton(label: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

it('opens the shared adjacent Peek and refreshes its saved exit data after a batch check', async () => {
  await act(async () => root.render(<ProxyPoolPage onManage={vi.fn()} />))
  const row = container.querySelector<HTMLElement>('[data-row-id="1"]')!
  expect(row.style.height).toBe('36px')
  await act(async () => row.click())
  const peek = container.querySelector('[data-peek]')
  expect(peek?.previousElementSibling?.contains(row)).toBe(true)
  expect(container.querySelector('[data-row-id="1"]')?.getAttribute('aria-current')).toBe('true')
  expect(proxyPoolApi.get).toHaveBeenCalledWith(1)

  const checkedAt = '2026-11-23T08:00:00Z'
  vi.mocked(proxyPoolApi.check).mockImplementation(async (id) => {
    if (id === '1') {
      rows = rows.map((entry) => entry.id === id ? {
        ...entry, checkStatus: 'ok', checkedAt, checkedScheme: 'http', latencyMs: 35,
        exitIp: '203.0.113.9', exitIpCheckedAt: checkedAt,
        ipHistory: [{ ip: '203.0.113.9', countryCode: 'DE', city: 'Berlin', firstSeen: checkedAt, lastSeen: checkedAt }],
      } : entry)
    }
    return { ok: id === '1', saved: true }
  })
  await clickButton('批量检测')
  expect(proxyPoolApi.check).toHaveBeenCalledTimes(2)
  expect(proxyPoolApi.check).toHaveBeenCalledWith('1', null)
  expect(proxyPoolApi.check).toHaveBeenCalledWith('2', null)
  expect(container.querySelector('[data-peek] [data-test-result]')?.textContent).toContain('35 ms')
  expect(container.querySelector('[data-peek] [data-history-item]')?.textContent).toContain('203.0.113.9')
})

it('checks only the selected endpoint or the currently opened endpoint', async () => {
  vi.mocked(proxyPoolApi.check).mockResolvedValue({ ok: true, saved: true })
  await act(async () => root.render(<ProxyPoolPage onManage={vi.fn()} />))
  const row = container.querySelector<HTMLElement>('[data-row-id="2"]')!
  await act(async () => row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  await clickButton('批量检测')
  expect(vi.mocked(proxyPoolApi.check).mock.calls).toEqual([['2', null]])
  await act(async () => container.querySelector<HTMLElement>('[data-row-id="1"]')!.click())
  await clickButton('检测出口')
  expect(vi.mocked(proxyPoolApi.check).mock.calls).toEqual([['2', null], ['1', null]])
})
