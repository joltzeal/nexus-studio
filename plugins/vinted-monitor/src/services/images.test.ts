import { describe, expect, it } from 'vitest'
import type { ItemRecord } from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import { sellerRecord } from '../domain/sellers.js'
import { VintedImages } from './images.js'

const url = 'https://images1.vinted.net/archived.jpg'
const item: ItemRecord = {
  id: 'vinted.fr:1',
  externalId: '1',
  domain: 'vinted.fr',
  monitorId: 'm',
  monitorIds: ['m'],
  title: 'Coat',
  price: '1',
  currency: 'EUR',
  brand: '',
  size: '',
  condition: '',
  url: 'https://vinted.fr/items/1',
  imageUrl: url,
  seller: '',
  userId: null,
  sellerProfile: null,
  images: [url],
  detail: {},
  favouriteCount: null,
  viewCount: null,
  starred: false,
  availabilityStatus: 'unknown',
  missingSince: null,
  missingMonitorId: null,
  statusCheckedAt: null,
  statusNote: null,
  collectedAt: '2026-10-25T00:00:00Z',
  listedAt: null,
  firstSeenAt: '2026-10-25T00:00:00Z',
  lastSeenAt: '2026-10-25T00:00:00Z',
}
function context(): DispatchContext {
  return {
    requestId: 'image',
    capability: 'monitor.collector',
    method: 'vinted.image.open',
    payload: {},
    deadlineAt: Date.now() + 60_000,
    assertAlive() {},
  }
}
function png(size = 300_000) {
  const bytes = Buffer.alloc(size, 0)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  return bytes
}

describe('bounded private image transfer', () => {
  it('returns byte-exact chunks smaller than the RPC limit and expires on close', async () => {
    const service = new VintedImages()
    const bytes = png()
    const meta = await service.open(
      item,
      url,
      (async () =>
        new Response(bytes, {
          headers: { 'content-type': 'image/png' },
        })) as typeof fetch,
      context(),
    )
    expect(meta).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      mime: 'image/png',
      size: 300_000,
      chunkSize: 262144,
    })
    const a = service.read(meta.id, 0)
    const b = service.read(meta.id, 262144)
    expect(
      Buffer.concat([Buffer.from(a.data, 'base64'), Buffer.from(b.data, 'base64')]),
    ).toEqual(bytes)
    expect(JSON.stringify(a).length).toBeLessThan(1024 * 1024)
    for (const offset of [-1, 1, 300_000])
      expect(() => service.read(meta.id, offset)).toThrow()
    expect(service.close(meta.id)).toEqual({ closed: true })
    expect(() => service.read(meta.id, 0)).toThrow()
  })

  it.each([
    'https://images1.vinted.net/unarchived.jpg',
    'https://images1.vinted.net.evil.test/a',
    'http://images1.vinted.net/archived.jpg',
    'https://u:p@images1.vinted.net/archived.jpg',
    'https://127.0.0.1/a',
    'https://images1.vinted.net:8443/archived.jpg',
  ])('rejects unowned or unsafe URL %s before requesting', async (candidate) => {
    let requests = 0
    await expect(
      new VintedImages().open(
        item,
        candidate,
        (async () => {
          requests++
          return new Response(png())
        }) as typeof fetch,
        context(),
      ),
    ).rejects.toThrow()
    expect(requests).toBe(0)
  })

  it('checks every redirect without carrying cookies and refuses destinations outside the CDN', async () => {
    const seen: string[] = []
    const service = new VintedImages()
    const transport = (async (input: string, init?: RequestInit) => {
      seen.push(input)
      expect(init?.redirect).toBe('manual')
      expect(init?.credentials).toBe('omit')
      return new Response(null, {
        status: 302,
        headers: { location: 'https://127.0.0.1/private' },
      })
    }) as typeof fetch
    await expect(service.open(item, url, transport, context())).rejects.toThrow()
    expect(seen).toEqual([url])
  })

  it('uses one supplied transport across allowed redirects', async () => {
    const service = new VintedImages()
    let calls = 0
    const meta = await service.open(
      item,
      url,
      (async () =>
        ++calls === 1
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://images2.vinted.net/new.png' },
            })
          : new Response(png(16), {
              headers: { 'content-type': 'image/png' },
            })) as typeof fetch,
      context(),
    )
    expect(calls).toBe(2)
    expect(meta.size).toBe(16)
    service.close(meta.id)
  })

  it('authorizes the associated seller avatar within the item scope', async () => {
    const avatar = 'https://images2.vinted.net/avatar.png'
    const sellerProfile = sellerRecord('vinted.fr', '42', item.collectedAt, {
      id: 42,
      photo: { url: avatar },
    })
    const service = new VintedImages()
    const request = (async () =>
      new Response(png(16), { headers: { 'content-type': 'image/png' } })) as typeof fetch
    const result = await service.open(
      { ...item, userId: '42', sellerProfile },
      avatar,
      request,
      context(),
    )
    expect(result).toMatchObject({ mime: 'image/png', size: 16 })
    service.close(result.id)
    await expect(service.open(item, avatar, request, context())).rejects.toThrow()
  })

  it('rejects MIME spoofing, declared oversize and streaming overflow', async () => {
    for (const response of [
      new Response('not an image', { headers: { 'content-type': 'image/png' } }),
      new Response(png(16), { headers: { 'content-type': 'image/jpeg' } }),
      new Response(png(16), {
        headers: {
          'content-type': 'image/png',
          'content-length': String(9 * 1024 * 1024),
        },
      }),
      new Response(png(8 * 1024 * 1024 + 1), {
        headers: { 'content-type': 'image/png' },
      }),
    ]) {
      await expect(
        new VintedImages().open(
          item,
          url,
          (async () => response) as typeof fetch,
          context(),
        ),
      ).rejects.toThrow()
    }
  })

  it('bounds a stalled body by the call deadline and permits subsequent downloads', async () => {
    let cancelled = false
    const service = new VintedImages()
    const pending = new ReadableStream({
      cancel() {
        cancelled = true
      },
    })
    await expect(
      service.open(
        item,
        url,
        (async () =>
          new Response(pending, {
            headers: { 'content-type': 'image/png' },
          })) as typeof fetch,
        { ...context(), deadlineAt: Date.now() + 20 },
      ),
    ).rejects.toThrow(/超时/)
    expect(cancelled).toBe(true)
    const meta = await service.open(
      item,
      url,
      (async () =>
        new Response(png(16), {
          headers: { 'content-type': 'image/png' },
        })) as typeof fetch,
      context(),
    )
    service.close(meta.id)
  })
})
