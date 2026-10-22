import { describe, expect, it, vi } from 'vitest'

import { cancelled, isPluginFailure } from '../domain/errors.js'
import type { IpReputation, ProxyInput } from '../domain/schemas.js'
import { Redactor } from '../rpc/redact.js'
import { createMemoryStore } from '../store/private-store.js'
import { createMemoryVault } from '../store/secret-vault.js'
import { applyCheckResult, checkEndpoint, performCheck } from './check.js'
import { createEndpoint } from './inventory.js'
import { TransportError } from './proxy-transport.js'

const now = () => new Date('2026-01-01T00:00:00.000Z')

function reputation(overrides: Partial<IpReputation> = {}): IpReputation {
  const base: IpReputation = {
    status: 'ok',
    source: 'proxycheck.io',
    ip: '203.0.113.9',
    checkedAt: '2026-01-01T00:00:00.000Z',
    cached: false,
    risk: 12,
    confidence: 90,
    proxy: true,
    vpn: false,
    tor: false,
    hosting: false,
    compromised: false,
    scraper: false,
    networkType: 'business',
    provider: 'Example ISP',
    asn: 'AS64500',
    error: null,
    geo: {
      status: 'ok',
      source: 'proxycheck.io',
      country: 'Germany',
      countryCode: 'DE',
      region: 'Berlin',
      city: 'Berlin',
      isp: 'Example ISP',
      error: null,
    },
  }
  return Object.assign(base, overrides)
}

function input(overrides: Partial<ProxyInput> = {}): ProxyInput {
  return {
    name: 'pool-1',
    schemes: ['socks5h', 'http'],
    host: 'proxy.example',
    port: 1080,
    username: 'user',
    password: 'p@ssw0rd',
    enabled: true,
    udp: true,
    groupId: null,
    ...overrides,
  }
}

async function setup(transport: Parameters<typeof performCheck>[2]['transport']) {
  const redactor = new Redactor()
  const store = createMemoryStore()
  const vault = createMemoryVault(redactor)
  const row = await store.mutate((document) =>
    createEndpoint(document, input(), { vault, now: () => now().toISOString() }),
  )
  const reputationMock = vi.fn(async () => reputation())
  const deps = { vault, transport, reputation: reputationMock, now }
  return { store, vault, row, deps, reputationMock }
}

describe('connectivity check', () => {
  it('records the exit IP, location and risk score', async () => {
    const { store, row, deps } = await setup(async () => ({
      status: 200,
      body: JSON.stringify({ ip: '203.0.113.9' }),
    }))
    const result = await checkEndpoint(
      store,
      row.id,
      { id: row.id, scheme: null, singleSchemeFallback: false },
      deps,
      { assertAlive: () => undefined },
    )
    expect(result.ok).toBe(true)
    expect(result.saved).toBe(true)
    expect(result.scheme).toBe('socks5h')
    expect(result.geo?.countryCode).toBe('DE')

    const document = await store.read()
    const saved = document.endpoints[0]
    expect(saved?.checkStatus).toBe('ok')
    expect(saved?.exitIp).toBe('203.0.113.9')
    expect(saved?.riskScore).toBe(12)
    expect(saved?.isProxy).toBe(true)
  })

  it('keeps the last successful observation after a failed check', async () => {
    let mode: 'ok' | 'fail' = 'ok'
    const { store, row, deps } = await setup(async () => {
      if (mode === 'fail') throw new TransportError('auth', 'denied')
      return { status: 200, body: JSON.stringify({ ip: '203.0.113.9' }) }
    })
    const inputValue = { id: row.id, scheme: null, singleSchemeFallback: false }
    await checkEndpoint(store, row.id, inputValue, deps, { assertAlive: () => undefined })
    mode = 'fail'
    const result = await checkEndpoint(store, row.id, inputValue, deps, {
      assertAlive: () => undefined,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('代理连接或认证失败，请检查协议和账号密码')

    const saved = (await store.read()).endpoints[0]
    expect(saved?.checkStatus).toBe('failed')
    expect(saved?.exitIp).toBe('203.0.113.9')
    expect(saved?.geo?.countryCode).toBe('DE')
  })

  it('classifies an HTTP 407 as an authentication failure', async () => {
    const { store, row, deps } = await setup(async () => ({ status: 407, body: '' }))
    const result = await checkEndpoint(
      store,
      row.id,
      { id: row.id, scheme: null, singleSchemeFallback: false },
      deps,
      { assertAlive: () => undefined },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('代理认证失败（HTTP 407）')
  })

  it('classifies a timeout without leaking the proxy authority', async () => {
    const { store, row, deps } = await setup(async () => {
      throw new TransportError('timeout', 'proxy.example:1080 timed out')
    })
    const result = await checkEndpoint(
      store,
      row.id,
      { id: row.id, scheme: null, singleSchemeFallback: false },
      deps,
      { assertAlive: () => undefined },
    )
    expect(result.error).toBe('代理请求超时')
    expect(JSON.stringify(result)).not.toContain('proxy.example')
  })

  it('rejects a protocol the endpoint does not configure', async () => {
    const { store, row, deps } = await setup(async () => ({ status: 200, body: '{}' }))
    await expect(
      checkEndpoint(
        store,
        row.id,
        { id: row.id, scheme: 'https', singleSchemeFallback: false },
        deps,
        { assertAlive: () => undefined },
      ),
    ).rejects.toThrow('代理 1 未配置所选协议 HTTPS')
  })

  it('writes nothing when the call was already cancelled', async () => {
    const { store, row, deps } = await setup(async () => ({
      status: 200,
      body: JSON.stringify({ ip: '203.0.113.9' }),
    }))
    const error = await checkEndpoint(
      store,
      row.id,
      { id: row.id, scheme: null, singleSchemeFallback: false },
      deps,
      {
        assertAlive: () => {
          throw cancelled()
        },
      },
    ).catch((reason: unknown) => reason)
    expect(isPluginFailure(error)).toBe(true)
    if (isPluginFailure(error)) expect(error.code).toBe('CANCELLED')
    const saved = (await store.read()).endpoints[0]
    expect(saved?.checkStatus).toBe('unknown')
    expect(saved?.exitIp).toBeNull()
  })

  it('drops a result that is older than the committed observation', async () => {
    const { store, row, deps } = await setup(async () => ({
      status: 200,
      body: JSON.stringify({ ip: '203.0.113.9' }),
    }))
    const result = await performCheck(
      row,
      { id: row.id, scheme: null, singleSchemeFallback: false },
      deps,
    )
    const applied = await store.mutate((document) => ({
      first: applyCheckResult(
        document,
        { ...result, checkedAt: '2026-05-05T00:00:00.000Z' },
        {
          id: row.id,
          fingerprint: row.fingerprint,
          schemes: row.schemes.join(','),
        },
      ),
      second: applyCheckResult(document, result, {
        id: row.id,
        fingerprint: row.fingerprint,
        schemes: row.schemes.join(','),
      }),
    }))
    expect(applied).toEqual({ first: true, second: false })
  })

  it('does not apply a result for credentials that changed in flight', async () => {
    const { store, row, deps } = await setup(async () => ({
      status: 200,
      body: JSON.stringify({ ip: '203.0.113.9' }),
    }))
    const result = await performCheck(
      row,
      { id: row.id, scheme: null, singleSchemeFallback: false },
      deps,
    )
    const applied = await store.mutate((document) =>
      applyCheckResult(document, result, {
        id: row.id,
        fingerprint: 'stale-fingerprint',
        schemes: row.schemes.join(','),
      }),
    )
    expect(applied).toBe(false)
    expect((await store.read()).endpoints[0]?.checkStatus).toBe('unknown')
  })

  it('reports a missing credential reference as NOT_CONFIGURED', async () => {
    const { store, vault, deps } = await setup(async () => ({
      status: 200,
      body: JSON.stringify({ ip: '203.0.113.9' }),
    }))
    const row = await store.mutate((document) =>
      createEndpoint(document, input({ port: 1081 }), {
        vault,
        now: () => now().toISOString(),
      }),
    )
    await store.mutate((document) => {
      const target = document.endpoints.find((entry) => entry.id === row.id)
      if (target === undefined) throw new Error('missing row')
      target.secretRef = 'mem:proxy-password:missing'
      return target
    })
    const error = await checkEndpoint(
      store,
      row.id,
      { id: row.id, scheme: null, singleSchemeFallback: false },
      deps,
      { assertAlive: () => undefined },
    ).catch((reason: unknown) => reason)
    expect(isPluginFailure(error)).toBe(true)
    if (isPluginFailure(error)) expect(error.code).toBe('NOT_CONFIGURED')
  })
})
