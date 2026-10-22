import { describe, expect, it, vi } from 'vitest'

import { UpstreamError } from '../domain/errors.js'
import { normalizeMonitorUrl } from '../domain/urls.js'
import { VintedClient } from './vinted.js'

type Handler = (url: string, init?: RequestInit) => Promise<Response>

function stubFetch(handler: Handler) {
  return vi.fn(async (url: string, init?: RequestInit) => await handler(url, init))
}

const target = normalizeMonitorUrl('https://www.vinted.fr/member/12-x')

function client(handler: Handler): VintedClient {
  return new VintedClient({ fetchImpl: stubFetch(handler) as unknown as typeof fetch })
}

async function failure(promise: Promise<unknown>): Promise<UpstreamError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof UpstreamError) return error
    throw error
  }
  throw new Error('expected the request to fail')
}

describe('vinted http client', () => {
  it('sends a browser-shaped request to the wardrobe endpoint', async () => {
    const fetchImpl = stubFetch(async () => Response.json({ items: [] }))
    const vinted = new VintedClient({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await vinted.items(target, 2, 24)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://vinted.fr/api/v2/wardrobe/12/items?page=2&per_page=24')
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers['user-agent']).toContain('Mozilla/5.0')
    expect(headers['accept']).toContain('application/json')
  })

  it.each([
    [429, 'rate-limit'],
    [401, 'blocked'],
    [403, 'blocked'],
    [404, 'upstream-refused'],
    [500, 'unavailable'],
    [302, 'upstream-network'],
  ])('maps status %i to %s', async (status, reason) => {
    const vinted = client(async () => new Response('', { status }))
    const error = await failure(vinted.items(target, 1, 20))
    expect(error.reason).toBe(reason)
  })

  it('reports invalid json instead of throwing a parse error', async () => {
    const vinted = client(async () => new Response('<html>nope</html>'))
    const error = await failure(vinted.items(target, 1, 20))
    expect(error.reason).toBe('invalid-response')
  })

  it('reports an aborted request as a timeout', async () => {
    const vinted = client(async () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    })
    const error = await failure(vinted.items(target, 1, 20))
    expect(error.reason).toBe('timeout')
  })

  it('reports a network failure as such', async () => {
    const vinted = client(async () => {
      throw new TypeError('fetch failed')
    })
    const error = await failure(vinted.items(target, 1, 20))
    expect(error.reason).toBe('upstream-network')
  })

  it('refuses a response larger than the cap', async () => {
    const vinted = new VintedClient({
      fetchImpl: stubFetch(
        async () => new Response('{}', { headers: { 'content-length': '99999999' } }),
      ) as unknown as typeof fetch,
      maxBytes: 1024,
    })
    const error = await failure(vinted.items(target, 1, 20))
    expect(error.reason).toBe('invalid-response')
  })

  it('parses items and pagination from a real-shaped payload', async () => {
    const vinted = client(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              { id: 5, title: 'Coat', price: { amount: '9.5', currency_code: 'EUR' } },
            ],
            pagination: { current_page: 1, total_pages: 2 },
          }),
        ),
    )
    const page = await vinted.items(target, 1, 20)
    expect(page.items[0]?.title).toBe('Coat')
    expect(page.items[0]?.url).toBe('https://vinted.fr/items/5')
    expect(page.hasMore).toBe(true)
  })
})
