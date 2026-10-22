import { describe, expect, it } from 'vitest'

import { UpstreamError } from '../domain/errors.js'
import {
  CATEGORIES,
  CATEGORY_IDS,
  SharedSupplyClient,
  decodeBody,
  encodeBody,
} from './upstream.js'

/** Mirrors what the supplier's client sends: base64 of AES-128-ECB ciphertext. */
function encryptedEnvelope(payload: unknown): string {
  return encodeBody(payload as Record<string, unknown>)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const product = {
  id: 12,
  title: '帆布包',
  price: '39',
  uid: 'M1',
  createdTime: 1_700_000_000,
  pics: { picList: ['https://product.aliyizhan.com/person/p.jpg'] },
}

describe('catalogue protocol', () => {
  it('round-trips a payload through the shared key', () => {
    const body = encodeBody({ pageSize: 80, typeId: '1', pageIndex: 0 })
    expect(decodeBody(body)).toEqual({ pageSize: 80, typeId: '1', pageIndex: 0 })
  })

  it('escapes non-ASCII before encrypting, like the reference client', () => {
    const body = encodeBody({ keyWord: '风衣' })
    // Decoding the ciphertext yields JSON escapes, not raw UTF-8.
    expect(JSON.stringify(decodeBody(body))).toBe(JSON.stringify({ keyWord: '风衣' }))
    expect(Buffer.from(body, 'base64').toString('latin1')).not.toContain('风衣')
  })

  it('rejects a body that is not valid ciphertext', () => {
    expect(() => decodeBody('bm90LWEtY2lwaGVy')).toThrow()
  })
})

describe('SharedSupplyClient', () => {
  it('decrypts a stores response and normalises the rows', async () => {
    const calls: string[] = []
    const client = new SharedSupplyClient({
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return jsonResponse(
          encryptedEnvelope({
            success: true,
            data: [{ id: 3, uid: 'M3', nickName: '三号铺', floor: '1F' }],
          }),
        )
      }) as typeof fetch,
    })
    const rows = await client.stores('1', 0)
    expect(calls[0]).toContain('/market/getMarketArchivesMouthsV2.action?marketCode=gz')
    expect(rows).toEqual([
      {
        id: '3',
        uid: 'M3',
        nickName: '三号铺',
        iconUrl: '',
        floor: '1F',
        houseNumber: '',
      },
    ])
  })

  it('maps a rate limit and a network failure to distinct reasons', async () => {
    const limited = new SharedSupplyClient({
      fetchImpl: (async () => new Response('', { status: 429 })) as typeof fetch,
    })
    await expect(limited.search('包', 0)).rejects.toMatchObject({ reason: 'rate-limit' })

    const offline = new SharedSupplyClient({
      fetchImpl: (async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch,
    })
    await expect(offline.search('包', 0)).rejects.toMatchObject({
      reason: 'upstream-network',
    })
  })

  it('reports a refused envelope with its message instead of an empty list', async () => {
    const client = new SharedSupplyClient({
      fetchImpl: (async () =>
        jsonResponse(
          encryptedEnvelope({ success: false, msg: '接口维护中', data: [] }),
        )) as typeof fetch,
    })
    const failure = await client.stores('1', 0).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(UpstreamError)
    expect(failure).toMatchObject({ reason: 'upstream-refused', detail: '接口维护中' })
  })

  it('treats an undecryptable body as an invalid response', async () => {
    const client = new SharedSupplyClient({
      fetchImpl: (async () => jsonResponse('not-ciphertext')) as typeof fetch,
    })
    await expect(client.products('M1', 0)).rejects.toMatchObject({
      reason: 'invalid-response',
    })
  })

  it('searches images over multipart and reads the plain JSON reply', async () => {
    let body: unknown
    const client = new SharedSupplyClient({
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = init?.body
        return jsonResponse({ success: true, data: [product] })
      }) as typeof fetch,
    })
    const rows = await client.imageSearch(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    expect(body).toBeInstanceOf(FormData)
    expect(rows[0]?.title).toBe('帆布包')
    expect(rows[0]?.coverUrl).toBe('https://product.aliyizhan.com/person/p.jpg')
  })
})

describe('categories', () => {
  it('exposes the ten ids the client can request', () => {
    expect(CATEGORIES).toHaveLength(10)
    expect(CATEGORY_IDS).toEqual(['1', '4', '7', '16', '30', '29', '26', '28', '27', '5'])
  })
})
