import { describe, expect, it, vi } from 'vitest'

import { PluginFailure } from '../domain/errors.js'
import { Sim8Client, normalizeBaseUrl, normalizeToken } from './client.js'

function respond(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function client(fetchImpl: typeof fetch, token = 'tok'): Sim8Client {
  return new Sim8Client({ baseUrl: 'https://api.example', token, fetchImpl })
}

async function failureOf(run: () => Promise<unknown>): Promise<PluginFailure> {
  try {
    await run()
  } catch (error) {
    if (error instanceof PluginFailure) return error
    throw error
  }
  throw new Error('调用没有失败')
}

describe('base url and token', () => {
  it('fills in the scheme and drops trailing slashes', () => {
    expect(normalizeBaseUrl('api.example.com/')).toBe('https://api.example.com')
    expect(normalizeBaseUrl(' http://127.0.0.1:8080/// ')).toBe('http://127.0.0.1:8080')
    expect(normalizeBaseUrl('')).toBe('https://api.cc')
  })

  it('refuses a scheme it cannot speak', () => {
    expect(() => normalizeBaseUrl('ftp://api.example')).toThrow(/http/)
    expect(() => normalizeBaseUrl('https://user:pass@api.example')).toThrow(/用户名/)
  })

  it('strips a copied Bearer prefix so it is not sent twice', () => {
    expect(normalizeToken('  Bearer abc123 ')).toBe('abc123')
    expect(normalizeToken('abc123')).toBe('abc123')
  })
})

describe('envelope handling', () => {
  it('returns data when the business code is 1', async () => {
    const fetchImpl = vi.fn(async () =>
      respond({ code: 1, msg: 'ok', data: { money: 5 } }),
    )
    const result = await client(fetchImpl as unknown as typeof fetch).get<{
      money: number
    }>('/api/v1/profile/info')
    expect(result.money).toBe(5)
  })

  it('sends the token as the Authorization header', async () => {
    // Typed as `fetch` so the recorded call keeps its argument tuple.
    const fetchImpl = vi.fn<typeof fetch>(async () => respond({ code: 1, data: null }))
    await client(fetchImpl as unknown as typeof fetch, 'abc').get('/x')
    const init = fetchImpl.mock.calls[0]?.[1]
    expect((init?.headers as Record<string, string>)['authorization']).toBe('abc')
  })

  it('surfaces the provider reason of a business failure', async () => {
    const fetchImpl = vi.fn(async () => respond({ code: 0, msg: '库存不足' }))
    const error = await failureOf(() =>
      client(fetchImpl as unknown as typeof fetch).post('/x'),
    )
    expect(error.code).toBe('UNAVAILABLE')
    expect(error.message).toBe('库存不足')
  })

  it('maps an auth failure from the envelope', async () => {
    const fetchImpl = vi.fn(async () => respond({ code: 401, msg: 'token 无效' }))
    const error = await failureOf(() =>
      client(fetchImpl as unknown as typeof fetch).get('/x'),
    )
    expect(error.code).toBe('AUTH_FAILED')
    expect(error.message).toBe('token 无效')
  })

  it('maps an auth failure from the status line', async () => {
    const fetchImpl = vi.fn(async () => respond({}, { status: 403 }))
    const error = await failureOf(() =>
      client(fetchImpl as unknown as typeof fetch).get('/x'),
    )
    expect(error.code).toBe('AUTH_FAILED')
  })

  it('maps a rate limit', async () => {
    const fetchImpl = vi.fn(async () => respond({ code: 429, msg: '太频繁' }))
    const error = await failureOf(() =>
      client(fetchImpl as unknown as typeof fetch).get('/x'),
    )
    expect(error.code).toBe('RATE_LIMITED')
  })

  it('reports a transport failure without leaking the URL', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:9')
    })
    const error = await failureOf(() =>
      client(fetchImpl as unknown as typeof fetch).get('/x'),
    )
    expect(error.code).toBe('UNAVAILABLE')
    expect(error.message).toContain('无法连接')
    expect(error.message).not.toContain('ECONNREFUSED')
  })

  it('reports a timeout', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    })
    const error = await failureOf(() =>
      client(fetchImpl as unknown as typeof fetch).get('/x'),
    )
    expect(error.code).toBe('TIMEOUT')
  })

  it('keeps a 2xx body that has no envelope', async () => {
    const fetchImpl = vi.fn(async () => respond({ list: [] }))
    const result = await client(fetchImpl as unknown as typeof fetch).get<{
      list: unknown[]
    }>('/x')
    expect(result.list).toEqual([])
  })

  it('reports a non-2xx answer without an envelope', async () => {
    const fetchImpl = vi.fn(async () => respond('bad gateway', { status: 502 }))
    const error = await failureOf(() =>
      client(fetchImpl as unknown as typeof fetch).get('/x'),
    )
    expect(error.message).toContain('502')
  })

  it('passes query parameters through and skips empty ones', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => respond({ code: 1, data: null }))
    await client(fetchImpl as unknown as typeof fetch).get('/x', {
      order_id: 3,
      empty: undefined,
    })
    const url = String(fetchImpl.mock.calls[0]?.[0])
    expect(url).toContain('order_id=3')
    expect(url).not.toContain('empty')
  })
})
