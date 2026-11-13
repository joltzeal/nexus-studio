import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PRODUCT_METHODS,
  ProductPageSchema,
  ProductPublicationReplySchema,
  ProductSaveReplySchema,
} from '../contracts.js'
import { startProductsPlugin } from '../index.js'
import manifest from '../../nexus.plugin.js'
import { createPluginServer } from './server.js'
import { createLogger, Redactor } from './redact.js'

interface Message {
  type?: string
  requestId?: string
  result?: unknown
  error?: { code: string }
  [key: string]: unknown
}
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function harness(handshake = true) {
  const input = new PassThrough()
  const output = new PassThrough()
  const diagnostics = new PassThrough()
  const messages: Message[] = []
  output.on('data', (data: Buffer) => {
    for (const line of data.toString('utf8').trim().split('\n'))
      messages.push(JSON.parse(line) as Message)
  })
  const instance = startProductsPlugin({ input, output, diagnostics })
  if (handshake) input.write('{"type":"handshake","protocolVersion":1}\n')
  cleanups.push(async () => {
    await instance.stop()
    input.destroy()
    output.destroy()
    diagnostics.destroy()
  })
  return {
    ...instance,
    input,
    messages,
    request(
      method: string,
      payload: unknown,
      options: { deadlineMs?: number; capability?: string } = {},
    ) {
      const requestId = randomUUID()
      input.write(
        `${JSON.stringify({
          protocolVersion: 1,
          requestId,
          capability: options.capability ?? 'product.catalog',
          method,
          deadlineMs: options.deadlineMs ?? 1000,
          payload,
        })}\n`,
      )
      return requestId
    },
    async response(requestId: string) {
      await vi.waitFor(() =>
        expect(messages.some((entry) => entry.requestId === requestId)).toBe(true),
      )
      return messages.find((entry) => entry.requestId === requestId)!
    },
  }
}

describe('product process protocol', () => {
  it('advertises only the product capability and methods and serves contract-validated results', async () => {
    const t = harness()
    expect(t.messages[0]).toMatchObject({
      type: 'hello',
      pluginId: 'studio.products',
      version: '1.0.0',
      capabilities: ['product.catalog'],
    })
    expect(t.messages[1]).toMatchObject({
      type: 'ready',
      pluginId: 'studio.products',
      methods: [...PRODUCT_METHODS],
      status: { storageDurable: false },
    })
    expect(manifest.minCoreVersion).toBe('0.1.29')
    expect(manifest.permissions).toEqual({
      networkDomains: [],
      wantsBrowserAccess: false,
      storage: 'private',
      secrets: [],
    })
    const saved = await t.response(
      t.request('products.save', {
        createKey: randomUUID(),
        data: { name: 'RPC product' },
      }),
    )
    expect(saved.ok).toBe(true)
    const product = ProductSaveReplySchema.parse(saved.result).product
    const page = await t.response(t.request('products.list', {}))
    expect(ProductPageSchema.parse(page.result)).toMatchObject({
      total: 1,
      items: [{ id: product.id, name: 'RPC product' }],
    })
    const publication = {
      productId: product.id,
      operationId: randomUUID(),
      windowId: randomUUID(),
      windowName: 'RPC test window',
      platform: 'test-market',
      listingId: 'synthetic-rpc-listing',
      listingUrl: 'https://example.invalid/listings/synthetic-rpc-listing',
      productRevision: 1,
      publishedAt: '2026-11-13T10:00:00.000Z',
    }
    const published = await t.response(
      t.request('products.publications.record', publication),
    )
    expect(published.ok).toBe(true)
    const result = ProductPublicationReplySchema.parse(published.result)
    expect(result).toMatchObject({
      alreadyRecorded: false,
      product: {
        revision: 2,
        status: 'draft',
        publicationCount: 1,
        latestPublication: { windowId: publication.windowId },
      },
    })
    expect(
      ProductPublicationReplySchema.parse(
        (await t.response(t.request('products.publications.record', publication))).result,
      ),
    ).toEqual({ product: result.product, alreadyRecorded: true })
  })

  it('rejects undeclared capabilities and calls before handshake without applying writes', async () => {
    const t = harness(false)
    t.request('products.save', {
      createKey: randomUUID(),
      data: { name: 'Must not save' },
    })
    expect(t.messages[1]).toMatchObject({ ok: false, error: { code: 'PROTOCOL_ERROR' } })
    t.input.write('{"type":"handshake","protocolVersion":1}\n')
    expect(
      await t.response(
        t.request(
          'products.save',
          {
            createKey: randomUUID(),
            data: { name: 'Wrong capability' },
          },
          { capability: 'image.provider' },
        ),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    })
    expect(await t.response(t.request('products.unknown', {}))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    })
    expect(
      ProductPageSchema.parse((await t.response(t.request('products.list', {}))).result)
        .total,
    ).toBe(0)
  })

  it.each(['cancel', 'deadline', 'stop'] as const)(
    'prevents a queued save after RPC %s',
    async (mode) => {
      const t = harness()
      let release!: () => void
      let entered!: () => void
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const blocker = t.store.mutate(async () => {
        entered()
        await gate
      })
      await enteredPromise
      const requestId = t.request(
        'products.save',
        {
          createKey: randomUUID(),
          data: { name: 'Late write' },
        },
        { deadlineMs: mode === 'deadline' ? 10 : 1000 },
      )
      if (mode === 'cancel')
        t.input.write(`${JSON.stringify({ type: 'cancel', requestId })}\n`)
      else if (mode === 'stop') await t.stop()
      if (mode !== 'stop') {
        expect(await t.response(requestId)).toMatchObject({
          ok: false,
          error: { code: mode === 'deadline' ? 'TIMEOUT' : 'CANCELLED' },
        })
      }
      release()
      await blocker
      await t.store.mutate(() => {})
      expect((await t.store.read()).products).toEqual([])
    },
  )

  it('rejects oversized output and never logs raw product exceptions', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const messages: Message[] = []
    const logs: string[] = []
    output.on('data', (data: Buffer) =>
      messages.push(JSON.parse(data.toString()) as Message),
    )
    const server = createPluginServer({
      input,
      output,
      manifest,
      methods: ['products.test'],
      dispatch: async ({ payload }) => {
        if (payload === 'throw') throw new Error('synthetic-private-product-value')
        return { data: 'x'.repeat(1024 * 1024) }
      },
      logger: createLogger((line) => logs.push(line), new Redactor()),
      status: () => ({}),
    })
    cleanups.push(() => {
      server.stop()
      input.destroy()
      output.destroy()
    })
    server.start()
    input.write('{"type":"handshake","protocolVersion":1}\n')
    for (const payload of ['large', 'throw']) {
      input.write(
        `${JSON.stringify({
          protocolVersion: 1,
          requestId: payload,
          capability: 'product.catalog',
          method: 'products.test',
          deadlineMs: 1000,
          payload,
        })}\n`,
      )
      await vi.waitFor(() =>
        expect(messages.some((entry) => entry.requestId === payload)).toBe(true),
      )
      expect(messages.find((entry) => entry.requestId === payload)).toMatchObject({
        ok: false,
        error: { code: 'UNAVAILABLE' },
      })
    }
    expect(JSON.stringify(messages)).not.toContain('synthetic-private-product-value')
    expect(logs.join('')).not.toContain('synthetic-private-product-value')
    expect(
      messages.every(
        (message) => Buffer.byteLength(JSON.stringify(message)) <= 1024 * 1024,
      ),
    ).toBe(true)
  })
})
