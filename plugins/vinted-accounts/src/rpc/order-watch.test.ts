import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { createVintedAccountsPlugin } from '../index.js'

describe('account order watch over plugin RPC', () => {
  it('does not commit an import queued before the host closes its input', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const diagnostics = new PassThrough()
    const instance = createVintedAccountsPlugin({ input, output, diagnostics })
    let release = () => {}
    const blocked = instance.store.mutate(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    try {
      await Promise.resolve()
      instance.server.start()
      input.write('{"type":"handshake","protocolVersion":1}\n')
      input.write(
        `${JSON.stringify({
          protocolVersion: 1,
          requestId: 'queued-import',
          capability: 'account.pool',
          method: 'configuration.import',
          payload: {
            schemaVersion: 1,
            data: {
              intervalMinutes: 5,
              bark: { enabled: false, baseUrl: 'https://api.day.app', deviceKey: '' },
            },
          },
          deadlineMs: 5000,
        })}\n`,
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      input.end()
      await new Promise<void>((resolve) => setImmediate(resolve))
      release()
      await blocked
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect((await instance.store.read()).orderWatch.settings.intervalMinutes).toBe(30)
    } finally {
      release()
      instance.stop()
      await instance.plugin.orders.stop()
      input.destroy()
      output.destroy()
      diagnostics.destroy()
    }
  })

  it.each(['cancel', 'deadline', 'EOF'])(
    'aborts a Bark test delivery on RPC %s',
    async (reason) => {
      const input = new PassThrough()
      const output = new PassThrough()
      const diagnostics = new PassThrough()
      let captured: AbortSignal | null = null
      let finish: () => void = () => {}
      const instance = createVintedAccountsPlugin({
        input,
        output,
        diagnostics,
        fetchImpl: async (_url, init) =>
          new Promise<Response>((resolve) => {
            captured = init?.signal ?? null
            finish = () => resolve(Response.json({ code: 200 }))
            captured?.addEventListener('abort', finish, { once: true })
          }),
      })
      try {
        await instance.plugin.call({
          requestId: 'config',
          capability: 'account.pool',
          method: 'vinted.accounts.orders.settings.save',
          payload: {
            intervalMinutes: 30,
            bark: {
              baseUrl: 'https://bark.example.test',
              deviceKey: 'synthetic-key',
              enabled: true,
            },
          },
          deadlineAt: Date.now() + 1000,
          assertAlive() {},
        })
        instance.server.start()
        input.write('{"type":"handshake","protocolVersion":1}\n')
        input.write(
          `${JSON.stringify({
            protocolVersion: 1,
            requestId: 'test-push',
            capability: 'account.pool',
            method: 'vinted.accounts.orders.bark.test',
            payload: {},
            deadlineMs: reason === 'deadline' ? 30 : 5000,
          })}\n`,
        )
        for (let step = 0; step < 100 && captured === null; step += 1) {
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        expect(captured).not.toBe(null)
        if (reason === 'cancel') {
          input.write('{"type":"cancel","requestId":"test-push"}\n')
        } else if (reason === 'EOF') {
          input.end()
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
        expect((captured as AbortSignal | null)?.aborted).toBe(true)
      } finally {
        finish()
        instance.stop()
        await instance.plugin.orders.stop()
        input.destroy()
        output.destroy()
        diagnostics.destroy()
      }
    },
  )

  it('connects saved homepage accounts, public page evidence and Bark through the same fetch route', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const diagnostics = new PassThrough()
    const clock = { value: new Date('2026-11-11T06:00:00.000Z') }
    const replies: Record<string, unknown>[] = []
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split('\n')) {
        replies.push(JSON.parse(line) as Record<string, unknown>)
      }
    })
    let items = [
      {
        id: 41,
        title: 'Vintage wooden frame',
        user_id: 42,
        url: 'https://www.vinted.fr/items/41-vintage-wooden-frame',
      },
    ]
    const requests: { url: string; init: RequestInit | undefined }[] = []
    const instance = createVintedAccountsPlugin({
      input,
      output,
      diagnostics,
      now: () => clock.value,
      fetchImpl: async (url, init) => {
        const address = String(url)
        requests.push({ url: address, init })
        if (address === 'https://www.vinted.fr/' && init?.method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'set-cookie': 'anonymous=fixture-session; Path=/; Secure' },
          })
        }
        if (address.includes('/api/v2/wardrobe/42/items?')) {
          expect(new Headers(init?.headers).get('cookie')).toBe(
            'anonymous=fixture-session',
          )
          return Response.json({
            code: 0,
            items,
            pagination: { current_page: 1, total_pages: 1, total_entries: items.length },
          })
        }
        if (address === 'https://www.vinted.fr/items/41-vintage-wooden-frame?locale=en') {
          return new Response(
            '<main><div class="web_ui__Cell__success"><span>Sold</span></div></main>',
            { headers: { 'content-type': 'text/html' } },
          )
        }
        if (address === 'https://bark.example.test/push' && init?.method === 'POST') {
          return Response.json({ code: 200 })
        }
        throw new Error('Unexpected request in isolated order-watch fixture')
      },
    })
    let requestNumber = 0
    async function rpc(method: string, payload: unknown = {}): Promise<unknown> {
      const requestId = `rpc-${++requestNumber}`
      input.write(
        `${JSON.stringify({
          protocolVersion: 1,
          requestId,
          capability: 'account.pool',
          method,
          payload,
          deadlineMs: 5000,
        })}\n`,
      )
      for (let step = 0; step < 100; step += 1) {
        const reply = replies.find((entry) => entry.requestId === requestId)
        if (reply) {
          expect(reply).toMatchObject({ ok: true })
          return reply.result
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      throw new Error('Isolated RPC did not return a result')
    }
    try {
      instance.server.start()
      input.write('{"type":"handshake","protocolVersion":1}\n')
      const ready = replies.find((entry) => entry.type === 'ready')
      expect(ready).toMatchObject({
        methods: expect.arrayContaining([
          'vinted.accounts.orders.list',
          'vinted.accounts.orders.settings.save',
          'configuration.export',
        ]),
      })
      const saved = (await rpc('vinted.accounts.save', {
        loginMethod: 'email',
        account: 'seller@example.test',
        password: 'synthetic-password-never-send',
        phone: '',
        emailOtpUrl: 'https://mail.example.test/inbox?token=never-send',
        smsOtpUrl: '',
        note: '',
        status: 'active',
        homepageUrl: 'https://vinted.fr/member/42',
      })) as { item: { id: string } }
      await rpc('vinted.accounts.orders.settings.save', {
        intervalMinutes: 30,
        bark: {
          baseUrl: 'https://bark.example.test',
          deviceKey: 'fixture-device-key',
          enabled: true,
        },
      })
      await instance.plugin.orders.tick()
      expect(requests.some((entry) => entry.url.includes('bark'))).toBe(false)

      items = []
      clock.value = new Date('2026-11-11T06:30:00.000Z')
      await instance.plugin.orders.tick()
      const result = await rpc('vinted.accounts.orders.list', {
        accountId: saved.item.id,
      })
      expect(result).toMatchObject({
        items: [
          {
            enabled: true,
            lastItemCount: 0,
            candidates: [
              {
                status: 'sold',
                itemId: '41',
                notifiedAt: '2026-11-11T06:30:00.000Z',
              },
            ],
          },
        ],
      })
      const delivery = requests.find((entry) => entry.url.includes('bark'))
      expect(JSON.parse(String(delivery?.init?.body))).toEqual({
        device_key: 'fixture-device-key',
        title: 'Vinted 商品已售',
        body: 'seller@example.test\nVintage wooden frame',
        url: 'https://www.vinted.fr/items/41-vintage-wooden-frame',
        group: 'Vinted 订单监控',
      })
      expect(JSON.stringify(requests)).not.toContain('synthetic-password-never-send')
      expect(JSON.stringify(requests)).not.toContain('mail.example.test')

      clock.value = new Date('2026-11-11T07:00:00.000Z')
      await instance.plugin.orders.tick()
      expect(requests.filter((entry) => entry.url.includes('bark'))).toHaveLength(1)
    } finally {
      await instance.plugin.orders.stop()
      instance.stop()
      input.destroy()
      output.destroy()
      diagnostics.destroy()
    }
  })
})
