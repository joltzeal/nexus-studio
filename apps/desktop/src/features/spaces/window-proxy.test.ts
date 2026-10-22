import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/proxy/api', () => ({
  checkProxy: vi.fn(),
  probeProxy: vi.fn(),
  getConfig: vi.fn(),
}))

const { checkProxy, getConfig, probeProxy } = await import('@/features/proxy/api')
const { checkWindowProxy, hasProxy } = await import('./window-proxy')

function result(ok: boolean) {
  return {
    id: '1',
    ok,
    scheme: 'http' as const,
    exitIp: ok ? '203.0.113.9' : null,
    geo: null,
    reputation: null,
    latencyMs: 120,
    error: ok ? null : '代理连接或认证失败，请检查协议和账号密码',
    checkedAt: '2026-10-22T12:00:00.000Z',
    saved: true,
  }
}

describe('window proxy gate', () => {
  beforeEach(() => {
    vi.mocked(checkProxy).mockReset()
    vi.mocked(probeProxy).mockReset()
    vi.mocked(getConfig).mockReset()
  })

  it('checks the endpoint a window pinned, not the plugin default', async () => {
    vi.mocked(checkProxy).mockResolvedValue(result(true))
    const outcome = await checkWindowProxy({
      proxy: null,
      proxyPlugin: 'studio.proxy-pool',
      proxyEndpoint: 7,
    })
    expect(checkProxy).toHaveBeenCalledWith('7', null, true)
    expect(getConfig).not.toHaveBeenCalled()
    expect(outcome).toEqual({ kind: 'checked', result: result(true) })
  })

  it('falls back to the default endpoint for a window that pinned nothing', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      defaultEndpointId: '3',
      risk: { enabled: false, cacheSeconds: 3600, hasApiKey: false },
    })
    vi.mocked(checkProxy).mockResolvedValue(result(false))
    const outcome = await checkWindowProxy({
      proxy: null,
      proxyPlugin: 'studio.proxy-pool',
      proxyEndpoint: null,
    })
    expect(checkProxy).toHaveBeenCalledWith('3', null, true)
    expect(outcome.kind).toBe('checked')
  })

  it('reports that nothing can be checked when the pool has no default', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      defaultEndpointId: null,
      risk: { enabled: false, cacheSeconds: 3600, hasApiKey: false },
    })
    const outcome = await checkWindowProxy({
      proxy: null,
      proxyPlugin: 'studio.proxy-pool',
      proxyEndpoint: null,
    })
    expect(outcome).toEqual({
      kind: 'unsupported',
      reason: '代理池插件还没有选择默认代理，无法检测',
    })
  })

  it('probes a typed address without touching the pool', async () => {
    vi.mocked(probeProxy).mockResolvedValue(result(true))
    await checkWindowProxy({
      proxy: 'http://proxy.example:8080',
      proxyPlugin: null,
      proxyEndpoint: null,
    })
    expect(probeProxy).toHaveBeenCalledWith('http://proxy.example:8080')
    expect(checkProxy).not.toHaveBeenCalled()
  })

  it('turns a rejected plugin call into an unsupported check, not a failure', async () => {
    vi.mocked(probeProxy).mockRejectedValue('代理池插件未运行')
    const outcome = await checkWindowProxy({
      proxy: 'http://proxy.example:8080',
      proxyPlugin: null,
      proxyEndpoint: null,
    })
    expect(outcome).toEqual({ kind: 'unsupported', reason: '代理池插件未运行' })
  })

  it('knows which windows have a proxy at all', () => {
    expect(hasProxy({ proxy: null, proxyPlugin: null, proxyEndpoint: null })).toBe(false)
    expect(
      hasProxy({
        proxy: 'http://proxy.example:8080',
        proxyPlugin: null,
        proxyEndpoint: null,
      }),
    ).toBe(true)
    expect(
      hasProxy({ proxy: null, proxyPlugin: 'studio.proxy-pool', proxyEndpoint: null }),
    ).toBe(true)
  })
})
