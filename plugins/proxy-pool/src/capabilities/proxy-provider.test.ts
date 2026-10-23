import type { Writable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

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
      connectionUrl: string
    }
    expect(resolved.configured).toBe(true)
    expect(resolved.configHandle).toBe(`nxproxy:v1:endpoint:${ids.first}`)
    expect(resolved.connectionUrl).toBe('http://first.example:8080')
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
    })) as { configHandle: string; connectionUrl: string }
    expect(resolved.configHandle).toBe(`nxproxy:v1:endpoint:${ids.second}`)
    expect(resolved.connectionUrl).toBe('socks5://second.example:1080')
  })

  it('materializes a pinned endpoint without requiring a default', async () => {
    const created = instance()
    const ids = await seed(created)
    expect(
      await call(created.plugin, 'proxy.resolve', { endpointId: ids.second }),
    ).toEqual({
      configured: true,
      configHandle: `nxproxy:v1:endpoint:${ids.second}`,
      connectionUrl: 'socks5://second.example:1080',
    })
  })

  it.each(['http', 'https', 'socks5', 'socks5h'])(
    'materializes %s with percent-encoded authentication',
    async (scheme) => {
      const created = instance()
      const endpoint = (await call(created.plugin, 'proxy.create', {
        name: 'authenticated',
        schemes: [scheme],
        host: '2001:db8::1',
        port: 1080,
        username: 'u:ser@/ ?#%',
        password: "p@ss:/%?# !'()*",
      })) as { id: string }
      const resolved = await call(created.plugin, 'proxy.resolve', {
        endpointId: Number(endpoint.id),
      })
      expect(resolved).toEqual({
        configured: true,
        configHandle: `nxproxy:v1:endpoint:${endpoint.id}`,
        secretRef: expect.any(String),
        connectionUrl: `${scheme}://u%3Aser%40%2F%20%3F%23%25:p%40ss%3A%2F%25%3F%23%20%21%27%28%29%2A@[2001:db8::1]:1080`,
      })

      await call(created.plugin, 'proxy.config.set', {
        defaultEndpointId: Number(endpoint.id),
      })
      const reference = await created.plugin.resolve()
      expect(reference).toEqual({
        configHandle: `nxproxy:v1:endpoint:${endpoint.id}`,
        secretRef: expect.any(String),
      })
      expect(reference).not.toHaveProperty('connectionUrl')
      const stored = JSON.stringify(await created.store.read())
      expect(stored).not.toContain("p@ss:/%?# !'()*")
      expect(stored).not.toContain('connectionUrl')
      expect(
        await call(created.plugin, 'proxy.get', { id: Number(endpoint.id) }),
      ).not.toHaveProperty('connectionUrl')
    },
  )

  it('fails when a pinned endpoint has lost its password', async () => {
    const created = instance()
    const endpoint = (await call(created.plugin, 'proxy.create', {
      name: 'authenticated',
      schemes: ['http'],
      host: 'auth.example',
      port: 8080,
      username: 'user',
      password: 'required-password',
    })) as { id: string }
    const document = await created.store.read()
    const ref = document.endpoints[0]?.secretRef
    if (ref === undefined || ref === null) throw new Error('missing test credential')
    await created.vault.drop(ref)

    await expect(
      call(created.plugin, 'proxy.resolve', { endpointId: Number(endpoint.id) }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  })

  it('uses one selected row snapshot for both the reference and connection', async () => {
    const created = instance()
    const ids = await seed(created)
    await call(created.plugin, 'proxy.config.set', {
      defaultEndpointId: ids.first,
    })
    const read = created.store.read.bind(created.store)
    const selection = vi.spyOn(created.store, 'read').mockImplementationOnce(async () => {
      const snapshot = await read()
      await created.store.mutate((document) => {
        document.config.defaultEndpointId = ids.second
        const row = document.endpoints.find((entry) => entry.id === ids.first)
        if (row === undefined) throw new Error('missing test endpoint')
        row.host = 'changed.example'
      })
      return snapshot
    })
    try {
      expect(await call(created.plugin, 'proxy.resolve', {})).toEqual({
        configured: true,
        configHandle: `nxproxy:v1:endpoint:${ids.first}`,
        connectionUrl: 'http://first.example:8080',
      })
    } finally {
      selection.mockRestore()
    }
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

  it.each(['missing', 'deleted', 'disabled'])(
    'never substitutes the default for a %s pinned endpoint',
    async (state) => {
      const created = instance()
      const ids = await seed(created)
      await call(created.plugin, 'proxy.config.set', {
        defaultEndpointId: ids.first,
      })
      if (state === 'deleted') {
        await call(created.plugin, 'proxy.delete', { ids: [ids.second] })
      } else if (state === 'disabled') {
        await call(created.plugin, 'proxy.update', {
          id: ids.second,
          name: 'second',
          schemes: ['socks5'],
          host: 'second.example',
          port: 1080,
          enabled: false,
        })
      }

      await expect(
        call(created.plugin, 'proxy.resolve', {
          endpointId: state === 'missing' ? 999 : ids.second,
        }),
      ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    },
  )
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
