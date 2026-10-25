import { describe, expect, it, vi } from 'vitest'

import manifest from '../../nexus.plugin.js'
import { normalizeMonitorUrl } from '../domain/urls.js'
import { describeFailure } from './collector.js'
import { VintedClient } from './vinted.js'

const target = normalizeMonitorUrl('https://www.vinted.com/member/3192040080')
const origin = 'https://www.vinted.com'

function sessionResponse(...cookies: string[]) {
  const headers = new Headers()
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(null, { headers })
}

function pageResponse(page = 1, total = 1, cookies: string[] = []) {
  const headers = new Headers()
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return Response.json(
    {
      code: 0,
      items: [{ id: page, title: 'Tin sign', user_id: 3192040080 }],
      pagination: { current_page: page, total_pages: total },
    },
    { headers },
  )
}

function setup(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  )
  return {
    request,
    client: new VintedClient({ fetchImpl: request as typeof fetch }),
  }
}

describe('Vinted anonymous collection session', () => {
  it('initializes the canonical www host before requesting the supplied member wardrobe', async () => {
    const { client, request } = setup(async (url, init) => {
      expect(manifest.permissions.networkDomains).toContain(new URL(url).hostname)
      if (init.method === 'HEAD') {
        expect(url).toBe(`${origin}/`)
        return sessionResponse('access_token_web=anonymous; Path=/; Secure; HttpOnly')
      }
      expect(url).toBe(
        `${origin}/api/v2/wardrobe/3192040080/items?page=1&per_page=20&order=newest_first`,
      )
      const headers = new Headers(init.headers)
      expect(headers.get('cookie')).toBe('access_token_web=anonymous')
      expect(headers.get('origin')).toBe(origin)
      expect(headers.get('referer')).toBe(`${origin}/`)
      expect(headers.get('locale')).toBe('en-US')
      expect(headers.get('platform')).toBe('web')
      expect(headers.get('x-next-app')).toBe('marketplace-web')
      expect(headers.get('x-money-object')).toBe('true')
      return pageResponse()
    })
    expect(await client.items(target, 1, 20)).toMatchObject({
      items: [{ id: '1', userId: '3192040080' }],
      hasMore: false,
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('reuses and updates cookies across pages and seller enrichment', async () => {
    const { client, request } = setup(async (url, init) => {
      if (init.method === 'HEAD') {
        return sessionResponse(
          'access_token_web=first; Path=/; Secure',
          'gone=expired; Path=/; Max-Age=0',
          'unrelated=secret; Domain=example.com; Path=/',
          'private=secret; Path=/private',
        )
      }
      const cookie = new Headers(init.headers).get('cookie')
      if (url.includes('page=1&')) {
        expect(cookie).toBe('access_token_web=first')
        return pageResponse(1, 2, ['access_token_web=rotated; Path=/; Secure'])
      }
      expect(cookie).toBe('access_token_web=rotated')
      if (url.includes('/users/')) {
        expect(url).toBe(`${origin}/api/v2/users/3192040080`)
        return Response.json({ code: 0, user: { id: 3192040080 } })
      }
      return pageResponse(2, 2)
    })
    await client.items(target, 1, 20)
    await client.items(target, 2, 20)
    await client.user(target.host, '3192040080')
    expect(request).toHaveBeenCalledTimes(4)
  })

  it('forwards the anonymous session to the same site catalogue sibling only', async () => {
    const { client } = setup(async (url, init) => {
      expect(manifest.permissions.networkDomains).toContain(new URL(url).hostname)
      const headers = new Headers(init.headers)
      if (init.method === 'HEAD') {
        expect(headers.get('cookie')).toBeNull()
        const site = new URL(url).hostname
        return sessionResponse(`access_token_web=${site}; Path=/; Secure`)
      }
      const host = new URL(url).hostname.replace(/^api\./, '')
      expect(new URL(url).hostname).toBe(`api.${host}`)
      expect(headers.get('cookie')).toBe(`access_token_web=www.${host}`)
      expect(headers.get('locale')).toBe(host === 'vinted.fr' ? 'fr-FR' : 'en-US')
      return Response.json({ items: [] })
    })
    await client.items(
      normalizeMonitorUrl('https://www.vinted.com/catalog?search_text=sign'),
      1,
      20,
    )
    await client.items(
      normalizeMonitorUrl('https://www.vinted.fr/catalog?search_text=sign'),
      1,
      20,
    )
  })

  it('creates a separate cookie session for every collection scope', async () => {
    let generation = 0
    const { client } = setup(async (_url, init) => {
      const headers = new Headers(init.headers)
      if (init.method === 'HEAD') {
        expect(headers.get('cookie')).toBeNull()
        generation += 1
        return sessionResponse(`access_token_web=run${generation}; Path=/; Secure`)
      }
      expect(headers.get('cookie')).toBe(`access_token_web=run${generation}`)
      return pageResponse()
    })
    for (let i = 0; i < 2; i++) {
      const scope = client.scope(null)
      try {
        await scope.client.items(target, 1, 20)
      } finally {
        await scope.transport.close()
      }
    }
    expect(generation).toBe(2)
  })

  it.each([401, 403])(
    'refreshes cookies once after HTTP %s without changing the route',
    async (status) => {
      let generation = 0
      const dispatchers: unknown[] = []
      const { client, request } = setup(async (_url, init) => {
        dispatchers.push((init as RequestInit & { dispatcher?: unknown }).dispatcher)
        if (init.method === 'HEAD') {
          expect(new Headers(init.headers).get('cookie')).toBeNull()
          generation += 1
          return sessionResponse(`access_token_web=run${generation}; Path=/; Secure`)
        }
        return generation === 1 ? new Response('', { status }) : pageResponse()
      })
      const scope = client.scope({
        id: 'proxy',
        name: 'Proxy',
        scheme: 'http',
        host: 'localhost',
        port: 1234,
        username: '',
        password: '',
        enabled: true,
      })
      try {
        expect((await scope.client.items(target, 1, 20)).items).toHaveLength(1)
        expect(request).toHaveBeenCalledTimes(4)
        expect(dispatchers[0]).toBeDefined()
        expect(dispatchers.every((dispatcher) => dispatcher === dispatchers[0])).toBe(
          true,
        )
      } finally {
        await scope.transport.close()
      }
    },
  )

  it('stops after the refreshed session is also refused', async () => {
    const { client, request } = setup(async (_url, init) =>
      init.method === 'HEAD'
        ? sessionResponse('access_token_web=anonymous; Path=/; Secure')
        : new Response('do not expose this upstream body', { status: 403 }),
    )
    const error: unknown = await client
      .items(target, 1, 20)
      .catch((error: unknown) => error)
    expect(describeFailure(error)).toContain('HTTP 403')
    expect(describeFailure(error)).not.toContain('upstream body')
    expect(request).toHaveBeenCalledTimes(4)
  })

  it('reports bootstrap failure and does not issue the API request', async () => {
    const { client, request } = setup(async () => new Response('', { status: 503 }))
    const error: unknown = await client
      .items(target, 1, 20)
      .catch((error: unknown) => error)
    expect(request.mock.calls[0]?.[1]?.method).toBe('HEAD')
    expect(describeFailure(error)).toContain('初始化会话')
    expect(describeFailure(error)).toContain('HTTP 503')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects unexpected redirects without following or exposing their location', async () => {
    const { client, request } = setup(async (_url, init) => {
      expect(init.redirect).toBe('manual')
      return init.method === 'HEAD'
        ? sessionResponse('access_token_web=secret; Path=/; Secure')
        : new Response('', {
            status: 302,
            headers: { location: 'https://example.com/?token=secret' },
          })
    })
    const error: unknown = await client
      .items(target, 1, 20)
      .catch((error: unknown) => error)
    expect(describeFailure(error)).toContain('重定向')
    expect(describeFailure(error)).toContain('HTTP 302')
    expect(describeFailure(error)).not.toContain('secret')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not refresh or retry a rate-limited API request', async () => {
    const { client, request } = setup(async (_url, init) =>
      init.method === 'HEAD'
        ? sessionResponse('access_token_web=anonymous; Path=/; Secure')
        : new Response('', { status: 429, headers: { 'retry-after': '300' } }),
    )
    await expect(client.items(target, 1, 20)).rejects.toMatchObject({
      reason: 'rate-limit',
      status: 429,
      phase: 'items',
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('keeps a single deadline through initialization, refresh and the API retry', async () => {
    const signals: AbortSignal[] = []
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (!init?.signal) throw new Error('Missing request deadline')
      signals.push(init.signal)
      if (init.method === 'HEAD') return sessionResponse()
      if (signals.length === 2) return new Response('', { status: 401 })
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        })
      })
    })
    const client = new VintedClient({ fetchImpl: request, timeoutMs: 30 })
    await expect(client.items(target, 1, 20)).rejects.toMatchObject({
      reason: 'timeout',
      phase: 'items',
    })
    expect(signals).toHaveLength(4)
    expect(signals.every((signal) => signal === signals[0])).toBe(true)
    expect(signals[0]?.aborted).toBe(true)
  })
})
