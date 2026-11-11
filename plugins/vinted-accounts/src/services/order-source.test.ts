import { afterEach, describe, expect, it, vi } from 'vitest'

import { PluginFailure } from '../domain/errors.js'
import {
  isSoldHtml,
  parseHomepage,
  VINTED_DOMAINS,
  VintedOrderSource,
  type OrderSource,
  type SnapshotItem,
} from './order-source.js'

const HOMEPAGE = 'https://www.vinted.fr/member/12'
const SOLD = '<div class="web_ui__Cell__success"><span>Sold</span></div>'
const ITEM: SnapshotItem = {
  id: '7',
  url: 'https://www.vinted.fr/items/7-coat',
  title: 'Coat',
  imageUrl: null,
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

function transport(handler: Handler): typeof fetch {
  return (async (input, init = {}) =>
    handler(new URL(String(input)), init)) as typeof fetch
}

function source(
  handler: Handler,
  options: { timeoutMs?: number; requestDelayMs?: number } = {},
) {
  return new VintedOrderSource({
    fetchImpl: transport((url, init) =>
      init.method === 'HEAD' ? new Response(null) : handler(url, init),
    ),
    requestDelayMs: 0,
    ...options,
  })
}

function rawItem(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Coat ${id}`,
    user_id: 12,
    url: `/items/${id}-coat`,
    photo: { url: `https://images1.vinted.net/${id}.jpg` },
    ...extra,
  }
}

function items(start: number, count: number) {
  return Array.from({ length: count }, (_, i) => rawItem(start + i))
}

function page(list: unknown[], current: number, total: number, entries?: number) {
  return {
    code: 0,
    items: list,
    pagination: {
      current_page: current,
      total_pages: total,
      per_page: 96,
      ...(entries === undefined ? {} : { total_entries: entries }),
    },
  }
}

function scan(client: OrderSource, signal = new AbortController().signal) {
  return client.scan(HOMEPAGE, signal)
}

function check(client: OrderSource, item = ITEM, signal = new AbortController().signal) {
  return client.check(item, HOMEPAGE, signal)
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('parseHomepage', () => {
  it.each([
    [' https://vinted.fr/member/12-seller/?tab=closet#items ', 'vinted.fr', '12'],
    ['http://www.vinted.co.uk/member/42', 'vinted.co.uk', '42'],
    ['https://WWW.VINTED.DE/member/00012-seller', 'vinted.de', '12'],
  ])('canonicalizes an allowed wardrobe %s', (value, host, userId) => {
    expect(parseHomepage(value)).toEqual({
      url: `https://www.${host}/member/${userId}`,
      host,
      userId,
    })
  })

  it('uses PluginFailure so homepage validation survives the host error boundary', () => {
    expect(() => parseHomepage('https://name:secret@evil.invalid/member/12')).toThrow(
      PluginFailure,
    )
  })

  it('exposes bare storefront domains that can all be canonicalized for the manifest', () => {
    for (const host of VINTED_DOMAINS) {
      expect(host).not.toMatch(/^www\./)
      expect(parseHomepage(`https://${host}/member/12`).url).toBe(
        `https://www.${host}/member/12`,
      )
    }
    expect(VINTED_DOMAINS).toContain('vinted.co.uk')
  })

  it.each([
    '',
    'not a URL',
    'https://vinted.fr/catalog',
    'https://vinted.fr/member/0',
    'https://vinted.fr/member/-12',
    `https://vinted.fr/member/${'1'.repeat(33)}`,
    'https://vinted.fr/member/12/extra',
    'https://vinted.fr/member/%31%32',
    'https://vinted.fr.evil.invalid/member/12',
    'https://evil.invalid/member/12',
    'https://api.vinted.fr/member/12',
    'https://vinted.fr./member/12',
    'https://vinted.fr:8443/member/12',
    'https://name:secret@vinted.fr/member/12',
    'file:///member/12',
    'https://vinted.fr\\@evil.invalid/member/12',
    `https://vinted.fr/member/12?key=${'x'.repeat(2048)}`,
  ])('rejects invalid homepage input without echoing it: %s', (value) => {
    expect(() => parseHomepage(value)).toThrow(/homepage|wardrobe|Vinted/i)
    try {
      parseHomepage(value)
    } catch (error) {
      expect(String(error)).not.toContain('secret')
      expect(String(error)).not.toContain('evil.invalid')
    }
  })
})

describe('complete wardrobe snapshots', () => {
  it('reads all 96-item pages before returning canonical snapshots', async () => {
    const requested: string[] = []
    const client: OrderSource = source((url) => {
      requested.push(url.toString())
      return Response.json(
        url.searchParams.get('page') === '1'
          ? page(items(1, 96), 1, 2, 99)
          : page(items(97, 3), 2, 2, 99),
      )
    })
    const result = await scan(client)
    expect(result).toHaveLength(99)
    expect(result[0]).toEqual({
      id: '1',
      url: 'https://www.vinted.fr/items/1-coat',
      title: 'Coat 1',
      imageUrl: 'https://images1.vinted.net/1.jpg',
    })
    expect(result.at(-1)?.id).toBe('99')
    expect(requested).toEqual([
      'https://www.vinted.fr/api/v2/wardrobe/12/items?page=1&per_page=96&order=newest_first',
      'https://www.vinted.fr/api/v2/wardrobe/12/items?page=2&per_page=96&order=newest_first',
    ])
  })

  it('does not publish a first page while a later page remains pending', async () => {
    let release: ((response: Response) => void) | undefined
    let settled = false
    const client = source((url) =>
      url.searchParams.get('page') === '1'
        ? Response.json(page(items(1, 96), 1, 2))
        : new Promise<Response>((resolve) => {
            release = resolve
          }),
    )
    const pending = scan(client).finally(() => {
      settled = true
    })
    void pending.catch(() => undefined)
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(settled).toBe(false)
    release?.(Response.json(page([rawItem(97)], 2, 2)))
    expect(await pending).toHaveLength(97)
  })

  it.each([0, 1])(
    'finishes an unannotated wardrobe with a short final page (%i)',
    async (count) => {
      const client = source((url) =>
        Response.json({
          items: url.searchParams.get('page') === '1' ? items(1, 96) : items(97, count),
        }),
      )
      expect(await scan(client)).toHaveLength(96 + count)
    },
  )

  it('accepts a genuinely empty wardrobe', async () => {
    expect(await scan(source(() => Response.json(page([], 1, 0, 0))))).toEqual([])
  })

  it('derives a missing listing URL and accepts a nested seller and optional image', async () => {
    const client = source(() =>
      Response.json({
        items: [
          {
            id: '9007199254740993',
            title: ' Coat ',
            user: { id: '12' },
            photos: [{ full_size_url: 'https://images1.vinted.net/coat.jpg' }],
          },
        ],
      }),
    )
    expect(await scan(client)).toEqual([
      {
        id: '9007199254740993',
        title: 'Coat',
        url: 'https://www.vinted.fr/items/9007199254740993',
        imageUrl: 'https://images1.vinted.net/coat.jpg',
      },
    ])
  })

  it('rejects a later HTTP failure and permits a fresh complete scan without partial state', async () => {
    let fail = true
    const client = source((url) => {
      if (url.searchParams.get('page') === '1')
        return Response.json(page(items(1, 96), 1, 2))
      return fail
        ? new Response('private upstream details', { status: 503 })
        : Response.json(page([rawItem(97)], 2, 2))
    })
    await expect(scan(client)).rejects.toThrow(/HTTP 503/)
    fail = false
    expect(await scan(client)).toHaveLength(97)
  })

  it.each([{ list: [rawItem(1), rawItem(1)] }, { list: [...items(1, 96), rawItem(1)] }])(
    'rejects repeated item IDs rather than returning an incomplete baseline',
    async ({ list }) => {
      const client = source(() => Response.json({ items: list }))
      await expect(scan(client)).rejects.toThrow(/重复|96/)
    },
  )

  it('rejects even one overlapping ID on a later page', async () => {
    const client = source((url) =>
      Response.json(
        url.searchParams.get('page') === '1'
          ? page(items(1, 96), 1, 2)
          : page([rawItem(96), rawItem(97)], 2, 2),
      ),
    )
    await expect(scan(client)).rejects.toThrow(/重复/)
  })

  it.each(
    [
      null,
      [],
      {},
      { items: null },
      { items: {} },
      { code: 1, items: [] },
      { items: [null] },
      { items: [rawItem(1, { id: 0 })] },
      { items: [rawItem(1, { id: Number.MAX_SAFE_INTEGER + 1 })] },
      { items: [rawItem(1, { title: '' })] },
      { items: [rawItem(1, { title: {} })] },
      { items: [rawItem(1, { user_id: null })] },
      { items: [rawItem(1, { user_id: 13 })] },
      { items: [rawItem(1, { user: { id: 13 } })] },
      { items: [rawItem(1, { user_id: true })] },
      { items: [rawItem(1, { url: 5 })] },
      { items: [rawItem(1, { url: 'https://www.vinted.de/items/1-coat' })] },
      { items: [rawItem(1, { url: 'https://evil.invalid/items/1' })] },
      { items: [rawItem(1, { url: 'https://www.vinted.fr/items/2' })] },
      { items: [rawItem(1, { url: 'https://name:secret@www.vinted.fr/items/1' })] },
      { items: [rawItem(1, { url: '//evil.invalid/items/1' })] },
      { items: [rawItem(1, { item_url: '/items/2' })] },
    ].map((payload) => ({ payload })),
  )('rejects malformed payloads and foreign item identities %j', async ({ payload }) => {
    await expect(scan(source(() => Response.json(payload)))).rejects.toThrow()
  })

  it.each(
    [
      [],
      'broken',
      { current_page: 2, total_pages: 1 },
      { current_page: null, total_pages: 1 },
      { current_page: true, total_pages: 1 },
      { total_pages: -1 },
      { total_pages: 1.5 },
      { total_pages: '1' },
      { total_pages: 0 },
      { total_pages: 21 },
      { total_pages: 2 },
      { next_page: 3 },
      { next_page: '2' },
      { next_page: false },
      { total_pages: 1, next_page: 2 },
      { total_pages: 2, next_page: null },
      { total_pages: 1, per_page: 20 },
      { total_pages: 1, total_entries: 2 },
      { total_pages: 1, total_entries: -1 },
      { total_pages: 1, total_entries: '1' },
    ].map((pagination) => ({ pagination })),
  )('rejects invalid or truncated pagination %j', async ({ pagination }) => {
    await expect(
      scan(source(() => Response.json({ items: [rawItem(1)], pagination }))),
    ).rejects.toThrow(/分页|截断|20|96|完整/)
  })

  it('rejects an empty final page when metadata promised another page of items', async () => {
    const client = source((url) =>
      Response.json(
        url.searchParams.get('page') === '1' ? page(items(1, 96), 1, 2) : page([], 2, 2),
      ),
    )
    await expect(scan(client)).rejects.toThrow(/分页|截断|完整/)
  })

  it('rejects changing totals while traversing the wardrobe', async () => {
    const client = source((url) =>
      Response.json(
        url.searchParams.get('page') === '1'
          ? page(items(1, 96), 1, 2, 97)
          : page([rawItem(97)], 2, 3, 193),
      ),
    )
    await expect(scan(client)).rejects.toThrow(/分页|变化|截断/)
  })

  it('rejects a wardrobe whose twentieth full page has no completion evidence', async () => {
    let requests = 0
    const client = source((url) => {
      requests += 1
      return Response.json({
        items: items((Number(url.searchParams.get('page')) - 1) * 96 + 1, 96),
      })
    })
    await expect(scan(client)).rejects.toThrow(/20|上限|完整/)
    expect(requests).toBe(20)
  })

  it('accepts exactly twenty pages when the final total proves completeness', async () => {
    const client = source((url) => {
      const current = Number(url.searchParams.get('page'))
      return Response.json(page(items((current - 1) * 96 + 1, 96), current, 20, 1920))
    })
    expect(await scan(client)).toHaveLength(1920)
  })

  it('accepts next_page pagination without totals when every intermediate page is complete', async () => {
    const client = source((url) => {
      const first = url.searchParams.get('page') === '1'
      return Response.json({
        items: first ? items(1, 96) : [rawItem(97)],
        pagination: { current_page: first ? 1 : 2, next_page: first ? 2 : null },
      })
    })
    expect(await scan(client)).toHaveLength(97)
  })
})

describe('anonymous storefront requests', () => {
  it('warms the canonical root with HEAD, respects cookie paths and inherits global fetch', async () => {
    const requests: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      transport((url, init) => {
        requests.push({ url: url.toString(), init })
        if (init.method === 'HEAD') {
          const headers = new Headers()
          headers.append('set-cookie', 'anonymous=first; Path=/; Secure; HttpOnly')
          headers.append('set-cookie', 'wardrobe=only; Path=/api/v2/wardrobe; Secure')
          headers.append('set-cookie', 'foreign=no; Domain=evil.invalid; Path=/')
          return new Response(null, { headers })
        }
        return url.pathname.startsWith('/items/')
          ? new Response(SOLD)
          : Response.json({ items: [] })
      }),
    )
    const client = new VintedOrderSource({ requestDelayMs: 0 })
    expect(await scan(client)).toEqual([])
    expect(await check(client)).toEqual({ sold: true, error: null })
    expect(requests[0]?.url).toBe('https://www.vinted.fr/')
    expect(requests[0]?.init.method).toBe('HEAD')
    expect(new Headers(requests[1]?.init.headers).get('cookie')).toBe(
      'wardrobe=only; anonymous=first',
    )
    expect(new Headers(requests[2]?.init.headers).get('cookie')).toBe('anonymous=first')
    for (const request of requests) {
      expect(request.init.redirect).toBe('manual')
      expect(request.init.credentials).toBe('omit')
      expect(request.init).not.toHaveProperty('dispatcher')
    }
    expect(new URL(requests[2]?.url ?? '').searchParams.get('locale')).toBe('en')
    expect(new Headers(requests[2]?.init.headers).get('locale')).toMatch(/^en(?:-|$)/)
    expect(new Headers(requests[2]?.init.headers).get('accept-language')).toMatch(/^en/)
  })

  it('isolates anonymous cookies across source instances and storefronts', async () => {
    const seen: string[] = []
    let warmups = 0
    const fetchImpl = transport((url, init) => {
      const cookie = new Headers(init.headers).get('cookie') ?? ''
      if (init.method === 'HEAD') {
        expect(cookie).toBe('')
        warmups += 1
        return new Response(null, {
          headers: { 'set-cookie': `anonymous=${warmups}; Path=/; Secure` },
        })
      }
      seen.push(`${url.hostname}:${cookie}`)
      return Response.json({ items: [] })
    })
    const first = new VintedOrderSource({ fetchImpl })
    await scan(first)
    await scan(first)
    await first.scan('https://vinted.de/member/12', new AbortController().signal)
    await scan(new VintedOrderSource({ fetchImpl }))
    expect(seen).toEqual([
      'www.vinted.fr:anonymous=1',
      'www.vinted.fr:anonymous=1',
      'www.vinted.de:anonymous=2',
      'www.vinted.fr:anonymous=3',
    ])
  })

  it.each([401, 403])(
    'refreshes the anonymous session only once after HTTP %i',
    async (status) => {
      let heads = 0
      let gets = 0
      const cookies: string[] = []
      const client = new VintedOrderSource({
        requestDelayMs: 0,
        fetchImpl: transport((_url, init) => {
          if (init.method === 'HEAD') {
            heads += 1
            return new Response(null, {
              headers: { 'set-cookie': `anonymous=${heads}; Path=/` },
            })
          }
          gets += 1
          cookies.push(new Headers(init.headers).get('cookie') ?? '')
          return gets === 1
            ? new Response(null, { status })
            : Response.json({ items: [] })
        }),
      })
      expect(await scan(client)).toEqual([])
      expect(cookies).toEqual(['anonymous=1', 'anonymous=2'])
      expect(heads).toBe(2)
    },
  )

  it('does not loop when refresh leaves a page blocked', async () => {
    let requests = 0
    const client = new VintedOrderSource({
      fetchImpl: transport((_url, init) => {
        requests += 1
        return new Response(null, { status: init.method === 'HEAD' ? 200 : 403 })
      }),
    })
    expect(await check(client)).toEqual({
      sold: false,
      error: expect.stringMatching(/HTTP 403.*拒绝/),
    })
    expect(requests).toBe(4)
  })

  it('limits refresh to once across an entire multi-page scan', async () => {
    let heads = 0
    let gets = 0
    const client = new VintedOrderSource({
      requestDelayMs: 0,
      fetchImpl: transport((url, init) => {
        if (init.method === 'HEAD') {
          heads += 1
          return new Response(null)
        }
        gets += 1
        return url.searchParams.get('page') === '1' && gets === 2
          ? Response.json(page(items(1, 96), 1, 2))
          : new Response(null, { status: 401 })
      }),
    })
    await expect(scan(client)).rejects.toThrow(/HTTP 401/)
    expect(heads).toBe(2)
    expect(gets).toBe(3)
  })

  it.each([
    [302, /重定向/],
    [404, /HTTP 404/],
    [407, /代理/],
    [429, /限流/],
    [503, /不可用/],
  ] as const)(
    'classifies HTTP %i without forwarding upstream details',
    async (status, expected) => {
      const client = source(
        () =>
          new Response('secret-key upstream', {
            status,
            headers: { location: 'https://evil.invalid/?key=secret-key' },
          }),
      )
      await expect(scan(client)).rejects.toThrow(expected)
      const result = await check(client)
      expect(result.sold).toBe(false)
      expect(result.error).toMatch(expected)
      expect(result.error).not.toMatch(/secret-key|evil.invalid/)
    },
  )

  it('stops after a failed warmup without sending a wardrobe request', async () => {
    const methods: string[] = []
    const client = new VintedOrderSource({
      fetchImpl: transport((_url, init) => {
        methods.push(init.method ?? '')
        return new Response(null, { status: 429 })
      }),
    })
    await expect(scan(client)).rejects.toThrow(/HTTP 429/)
    expect(methods).toEqual(['HEAD'])
  })

  it('redacts transport error messages and abort reasons', async () => {
    const client = source(() => {
      throw new Error('https://name:secret-key@proxy.invalid')
    })
    await expect(scan(client)).rejects.toThrow(/网络|请求/)
    const result = await check(client)
    expect(result.error).not.toMatch(/secret-key|proxy.invalid/)
    const controller = new AbortController()
    controller.abort(new Error('private-abort-key'))
    expect((await check(client, ITEM, controller.signal)).error).toMatch(/取消/)
    expect((await check(client, ITEM, controller.signal)).error).not.toContain(
      'private-abort-key',
    )
  })
})

describe('bounded operation lifetime and bodies', () => {
  it('does not issue a request for an already aborted scan', async () => {
    let requested = false
    const client = source(() => {
      requested = true
      return Response.json({ items: [] })
    })
    const controller = new AbortController()
    controller.abort()
    await expect(scan(client, controller.signal)).rejects.toThrow(/取消/)
    expect(requested).toBe(false)
  })

  it('bounds a warmup fetch even when the transport ignores its signal', async () => {
    const client = new VintedOrderSource({
      timeoutMs: 20,
      fetchImpl: transport(() => new Promise<Response>(() => {})),
    })
    await expect(scan(client)).rejects.toThrow(/超时|截止/)
  })

  it('cancels a late response from a fetch that ignored caller abort', async () => {
    const controller = new AbortController()
    let release: ((response: Response) => void) | undefined
    let cancelled = false
    const client = source(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    const pending = scan(client, controller.signal)
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: expect.stringContaining('取消'),
    })
    await vi.waitFor(() => expect(release).toBeDefined())
    controller.abort(new Error('secret-key'))
    await assertion
    release?.(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
      ),
    )
    await vi.waitFor(() => expect(cancelled).toBe(true))
  })

  it('cancels a stalled response body when the deadline expires', async () => {
    let cancelled = false
    const client = source(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            },
          }),
        ),
      { timeoutMs: 20 },
    )
    await expect(scan(client)).rejects.toThrow(/超时|截止/)
    expect(cancelled).toBe(true)
  })

  it('cancels an in-progress item body on caller abort without inferring a sale', async () => {
    const controller = new AbortController()
    let cancelled = false
    let started = false
    const client = source(
      () =>
        new Response(
          new ReadableStream({
            start(stream) {
              started = true
              stream.enqueue(new TextEncoder().encode(SOLD))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    )
    const pending = check(client, ITEM, controller.signal)
    await vi.waitFor(() => expect(started).toBe(true))
    controller.abort(new Error('secret-key'))
    expect(await pending).toEqual({ sold: false, error: expect.stringMatching(/取消/) })
    expect(cancelled).toBe(true)
  })

  it('bounds cleanup even when a response stream refuses to finish cancellation', async () => {
    const client = source(
      () =>
        new Response(
          new ReadableStream({
            cancel: () => new Promise<void>(() => {}),
          }),
        ),
      { timeoutMs: 20 },
    )
    expect(await check(client)).toEqual({
      sold: false,
      error: expect.stringMatching(/超时|截止/),
    })
  })

  it('includes inter-page pacing in the operation deadline', async () => {
    let gets = 0
    const client = source(
      () => {
        gets += 1
        return Response.json(page(items(1, 96), 1, 2))
      },
      { timeoutMs: 30, requestDelayMs: 1000 },
    )
    await expect(scan(client)).rejects.toThrow(/超时|截止/)
    expect(gets).toBe(1)
  })

  it('does not reset the deadline for another page', async () => {
    vi.useFakeTimers()
    const client = source(
      async (url) => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return Response.json(
          url.searchParams.get('page') === '1'
            ? page(items(1, 96), 1, 2)
            : page([rawItem(97)], 2, 2),
        )
      },
      { timeoutMs: 50 },
    )
    const assertion = expect(scan(client)).rejects.toThrow(/超时|截止/)
    void assertion.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(50)
    await assertion
  })

  it.each(['declared', 'streamed'])(
    'rejects an oversized wardrobe body (%s)',
    async (mode) => {
      let cancelled = false
      const client = source(
        () =>
          new Response(
            new ReadableStream({
              start(stream) {
                if (mode === 'streamed')
                  stream.enqueue(new Uint8Array(4 * 1024 * 1024 + 1))
              },
              cancel() {
                cancelled = true
              },
            }),
            { headers: mode === 'declared' ? { 'content-length': '99999999' } : {} },
          ),
      )
      await expect(scan(client)).rejects.toThrow(/大小|上限/)
      expect(cancelled).toBe(true)
    },
  )

  it('counts item HTML in bytes and rejects a Sold marker in an oversized response', async () => {
    const client = source(() => new Response(SOLD + '\u00e9'.repeat(1_000_001)))
    const result = await check(client)
    expect(result.sold).toBe(false)
    expect(result.error).toMatch(/大小|上限/)
  })

  it('rejects invalid JSON instead of treating it as an empty wardrobe', async () => {
    await expect(
      scan(source(() => new Response('<html>blocked</html>'))),
    ).rejects.toThrow(/JSON|响应/)
  })
})

describe('strict item-page sale evidence', () => {
  it.each([
    SOLD,
    '<div class="other web_ui__Cell__success extra"> \n Sold &nbsp; </div>',
    '<DIV CLASS="web_ui__Cell__success"><strong>So</strong>ld</DIV>',
    '<div class="web_ui__Cell__success">S&#111;ld</div>',
    '<div class="web_ui__Cell__success"><span hidden>Unavailable</span>Sold</div>',
    '<div class="web_ui__Cell__success">So<div hidden>Unavailable</div>ld</div>',
    '<div class="web_ui__Cell__success">So<br hidden>ld</div>',
    '<div class="web_ui__Cell__success"><img alt="Listing">Sold<br></div>',
  ])('recognizes visible exact Sold text in the success div: %s', async (html) => {
    expect(isSoldHtml(html)).toBe(true)
    expect(await check(source(() => new Response(html)))).toEqual({
      sold: true,
      error: null,
    })
  })

  it.each([
    '',
    '<div>Sold</div>',
    '<span class="web_ui__Cell__success">Sold</span>',
    '<div class="web_ui__Cell__success-extra">Sold</div>',
    '<div class="web_ui__Cell__success">Not Sold</div>',
    '<div class="web_ui__Cell__success">Sold today</div>',
    '<div class="web_ui__Cell__success">sold</div>',
    '<div class="web_ui__Cell__success">Sold',
    '<!-- <div class="web_ui__Cell__success">Sold</div> -->',
    '<script>const html = \'<div class="web_ui__Cell__success">Sold</div>\'</script>',
    '<style>.x::before { content: \'<div class="web_ui__Cell__success">Sold</div>\' }</style>',
    `<template>${SOLD}</template>`,
    `<noscript>${SOLD}</noscript>`,
    '<div class="web_ui__Cell__success"><script>Sold</script></div>',
    '<div class="web_ui__Cell__success" hidden>Sold</div>',
    '<div hidden="false"><div class="web_ui__Cell__success">Sold</div></div>',
    `<section aria-hidden="true">${SOLD}</section>`,
    `<section style="DISPLAY : none !important">${SOLD}</section>`,
    `<section style="visibility: hidden">${SOLD}</section>`,
    `<section style="opacity: 0">${SOLD}</section>`,
    `<section style="display: none /* hidden */">${SOLD}</section>`,
    `<section class="hidden">${SOLD}</section>`,
    `<section class="sr-only">${SOLD}</section>`,
    `<details>${SOLD}</details>`,
    `<dialog>${SOLD}</dialog>`,
    '<div class="web_ui__Cell__success">So<br>ld</div>',
    '<div class="web_ui__Cell__success"><p>So</p><p>ld</p></div>',
    '<div class="web_ui__Cell__success"><span hidden>Sold</span></div>',
    '<div data-html=\'<div class="web_ui__Cell__success">Sold</div>\'>Available</div>',
    '<html><h1>Access denied</h1><p>This listing may be Sold</p></html>',
  ])(
    'does not turn hidden, unrelated or incomplete markup into a sale: %s',
    async (html) => {
      expect(isSoldHtml(html)).toBe(false)
      const result = await check(source(() => new Response(html)))
      expect(result.sold).toBe(false)
      expect(result.error).toMatch(/Sold|HTML|page/i)
    },
  )

  it.each([
    { ...ITEM, id: '8' },
    { ...ITEM, url: 'https://www.vinted.de/items/7' },
    { ...ITEM, url: 'https://evil.invalid/items/7?key=secret-key' },
    { ...ITEM, url: 'https://name:secret-key@www.vinted.fr/items/7' },
    { ...ITEM, url: 'https://www.vinted.fr:8443/items/7' },
  ])('rejects a mismatched item before making any request %j', async (item) => {
    let requests = 0
    const client = new VintedOrderSource({
      fetchImpl: transport(() => {
        requests += 1
        return new Response(SOLD)
      }),
    })
    const result = await check(client, item)
    expect(result.sold).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.error).not.toContain('secret-key')
    expect(requests).toBe(0)
  })

  it('does not accept a Sold marker embedded in a non-HTML response', async () => {
    const client = source(
      () => new Response(SOLD, { headers: { 'content-type': 'application/json' } }),
    )
    expect((await check(client)).sold).toBe(false)
  })
})
