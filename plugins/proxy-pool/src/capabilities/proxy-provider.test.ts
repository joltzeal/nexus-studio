import type { Writable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { createProxyPlugin } from '../index.js'

/** A sink that swallows diagnostics; the plugin only ever calls `.write`. */
const sink = { write: () => true } as unknown as Writable

const now = () => new Date('2026-01-01T00:00:00.000Z')

/** Drives the capability exactly as the RPC server would. */
function call(
  plugin: ReturnType<typeof createProxyPlugin>['plugin'],
  method: string,
  payload: unknown,
): Promise<unknown> {
  return plugin.call({
    requestId: 'req-1',
    capability: 'proxy.provider',
    method,
    payload,
    deadlineAt: Date.now() + 30_000,
    assertAlive: () => undefined,
  })
}

function instance() {
  const created = createProxyPlugin({
    now,
    diagnostics: sink,
    transport: async () => ({ status: 200, body: JSON.stringify({ ip: '203.0.113.9' }) }),
    fetchImpl: (async () =>
      new Response(JSON.stringify({ status: 'ok' }))) as typeof fetch,
  })
  return created
}

async function seed(created: ReturnType<typeof createProxyPlugin>) {
  const first = (await call(created.plugin, 'proxy.create', {
    name: 'first',
    schemes: ['http'],
    host: 'first.example',
    port: 8080,
    username: '',
    password: '',
    enabled: true,
    udp: false,
    groupId: null,
  })) as { id: string }
  const second = (await call(created.plugin, 'proxy.create', {
    name: 'second',
    schemes: ['socks5'],
    host: 'second.example',
    port: 1080,
    username: '',
    password: '',
    enabled: true,
    udp: false,
    groupId: null,
  })) as { id: string }
  return { first: Number(first.id), second: Number(second.id) }
}

describe('proxy resolution for a window', () => {
  it('falls back to the default endpoint when the window pins nothing', async () => {
    const created = instance()
    const ids = await seed(created)
    await call(created.plugin, 'proxy.config.set', {
      defaultEndpointId: ids.first,
      riskEnabled: false,
      riskCacheSeconds: 3600,
    })
    const resolved = (await call(created.plugin, 'proxy.resolve', {})) as {
      configured: boolean
      configHandle: string
    }
    expect(resolved.configured).toBe(true)
    expect(resolved.configHandle).toBe(`nxproxy:v1:endpoint:${ids.first}`)
  })

  it('resolves the endpoint a window picked from the pool', async () => {
    const created = instance()
    const ids = await seed(created)
    await call(created.plugin, 'proxy.config.set', {
      defaultEndpointId: ids.first,
      riskEnabled: false,
      riskCacheSeconds: 3600,
    })
    const resolved = (await call(created.plugin, 'proxy.resolve', {
      endpointId: ids.second,
    })) as { configHandle: string }
    expect(resolved.configHandle).toBe(`nxproxy:v1:endpoint:${ids.second}`)
  })

  it('reports nothing configured without a default and without a pinned row', async () => {
    const created = instance()
    await seed(created)
    expect(await call(created.plugin, 'proxy.resolve', {})).toEqual({
      configured: false,
      configHandle: null,
      secretRef: null,
    })
  })

  it('blocks a window whose pinned endpoint was deleted', async () => {
    const created = instance()
    const ids = await seed(created)
    await call(created.plugin, 'proxy.delete', { ids: [ids.second] })
    await expect(
      call(created.plugin, 'proxy.resolve', { endpointId: ids.second }),
    ).rejects.toThrow('窗口指定的代理已被删除，请重新选择')
  })
})

describe('ad-hoc proxy probe', () => {
  it('measures a typed proxy without adding it to the pool', async () => {
    const created = instance()
    const result = (await call(created.plugin, 'proxy.probe', {
      url: 'socks5h://user:p%40ss@probe.example:1080',
    })) as {
      ok: boolean
      exitIp: string
      reputation: unknown | null
      saved: boolean
    }
    expect(result.ok).toBe(true)
    expect(result.exitIp).toBe('203.0.113.9')
    // The reputation call is stubbed, so only its presence is asserted here.
    expect(result.reputation).not.toBeNull()
    expect(result.saved).toBe(false)

    const listed = (await call(created.plugin, 'proxy.list', {})) as { total: number }
    expect(listed.total).toBe(0)
  })

  it('reports a failed probe instead of throwing', async () => {
    const created = createProxyPlugin({
      now,
      diagnostics: sink,
      transport: async () => ({ status: 407, body: '' }),
    })
    const result = (await call(created.plugin, 'proxy.probe', {
      url: 'http://probe.example:8080',
    })) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe('代理认证失败（HTTP 407）')
  })

  it('rejects a malformed proxy URL without echoing it', async () => {
    const created = instance()
    const error = await call(created.plugin, 'proxy.probe', {
      url: 'probe.example:8080',
    }).catch((reason: unknown) => reason)
    expect(String(error)).toContain('代理 URL 无效')
    expect(String(error)).not.toContain('probe.example')
  })
})
