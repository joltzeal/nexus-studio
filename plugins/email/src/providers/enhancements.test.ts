import { describe, expect, it, vi } from 'vitest'
import { MicrosoftEmailFactory } from './microsoft.js'

const session = { email: 'reader@example.test', accessToken: 'synthetic-access' }
const signal = () => new AbortController().signal
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
const message = {
  id: 'fixture_id',
  subject: 'Hello',
  from: { emailAddress: { name: 'Sender', address: 'sender@example.test' } },
  receivedDateTime: '2026-11-12T02:00:00Z',
  isRead: false,
  hasAttachments: false,
  bodyPreview: 'Hello',
}

describe('Graph reception and verified writes', () => {
  it.each(['all', 'unread', 'read'] as const)(
    'returns accurate whole-folder counts with the %s filter ordered for Graph',
    async (readState) => {
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input))
        if (!url.pathname.endsWith('/messages')) {
          expect(url.pathname).toBe('/v1.0/me/mailFolders/inbox')
          expect(url.searchParams.get('$select')).toBe('totalItemCount,unreadItemCount')
          return json({ totalItemCount: 80, unreadItemCount: 25 })
        }
        expect(url.searchParams.get('$orderby')).toBe('receivedDateTime desc')
        const filter = url.searchParams.get('$filter')
        if (readState === 'all') expect(filter).toBeNull()
        else {
          expect(filter).toBe(
            `receivedDateTime ge 0001-01-01T00:00:00Z and isRead eq ${readState === 'read'}`,
          )
        }
        return json({ value: [{ ...message, isRead: readState === 'read' }] })
      })
      const mailbox = new MicrosoftEmailFactory({ fetchImpl }).create('graph').mailbox
      expect(
        await mailbox.list(session, { folder: 'inbox', readState }, signal()),
      ).toMatchObject({
        total: 80,
        unread: 25,
        items: [{ isRead: readState === 'read' }],
      })
    },
  )

  it('rejects a continuation from another read-state filter before a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      new URL(String(input)).pathname.endsWith('/messages')
        ? json({
            value: [message],
            '@odata.nextLink':
              'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=20',
          })
        : json({ totalItemCount: 80, unreadItemCount: 25 }),
    )
    const mailbox = new MicrosoftEmailFactory({ fetchImpl }).create('graph').mailbox
    const first = await mailbox.list(
      session,
      { folder: 'inbox', readState: 'unread' },
      signal(),
    )
    const requests = fetchImpl.mock.calls.length
    await expect(
      mailbox.list(
        session,
        {
          folder: 'inbox',
          readState: 'read',
          cursor: first.nextCursor!,
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(fetchImpl).toHaveBeenCalledTimes(requests)
  })

  it('does not silently accept malformed folder counts', async () => {
    const mailbox = new MicrosoftEmailFactory({
      fetchImpl: async (input) =>
        new URL(String(input)).pathname.endsWith('/messages')
          ? json({ value: [] })
          : json({ totalItemCount: 1, unreadItemCount: 2 }),
    }).create('graph').mailbox
    await expect(
      mailbox.list(session, { folder: 'inbox' }, signal()),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })

  it.each([true, false])('confirms a Graph isRead=%s response', async (isRead) => {
    const mailbox = new MicrosoftEmailFactory({
      fetchImpl: async (input, init) => {
        expect(new URL(String(input)).pathname).toBe(
          '/v1.0/me/mailFolders/inbox/messages/fixture_id',
        )
        expect(init?.method).toBe('PATCH')
        expect(JSON.parse(String(init?.body))).toEqual({ isRead })
        return json({ id: 'fixture_id', isRead })
      },
    }).create('graph').mailbox
    await expect(
      mailbox.setRead(
        session,
        { folder: 'inbox', messageId: 'fixture_id', isRead },
        signal(),
      ),
    ).resolves.toBeUndefined()
  })

  it.each([{}, { id: 'other', isRead: true }, { id: 'fixture_id', isRead: false }])(
    'rejects an unconfirmed write response %j',
    async (body) => {
      const mailbox = new MicrosoftEmailFactory({
        fetchImpl: async () => json(body),
      }).create('graph').mailbox
      await expect(
        mailbox.setRead(
          session,
          {
            folder: 'inbox',
            messageId: 'fixture_id',
            isRead: true,
          },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    },
  )

  it('reads back an empty successful Graph write before confirming it', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) =>
      init?.method === 'PATCH'
        ? new Response(null, { status: 204 })
        : json({ id: 'fixture_id', isRead: true }),
    )
    const mailbox = new MicrosoftEmailFactory({ fetchImpl }).create('graph').mailbox
    await mailbox.setRead(
      session,
      { folder: 'inbox', messageId: 'fixture_id', isRead: true },
      signal(),
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('keeps read-only Graph reception available after a forbidden write', async () => {
    const mailbox = new MicrosoftEmailFactory({
      fetchImpl: async (input, init) => {
        if (init?.method === 'PATCH') return json({}, 403)
        return new URL(String(input)).pathname.endsWith('/messages')
          ? json({ value: [message] })
          : json({ totalItemCount: 1, unreadItemCount: 1 })
      },
    }).create('graph').mailbox
    await expect(
      mailbox.setRead(
        session,
        {
          folder: 'inbox',
          messageId: 'fixture_id',
          isRead: true,
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(await mailbox.list(session, { folder: 'inbox' }, signal())).toMatchObject({
      total: 1,
      unread: 1,
      items: [{ isRead: false }],
    })
  })
})

describe('bounded rich email bodies', () => {
  const read = (content: string, contentType = 'html') =>
    new MicrosoftEmailFactory({
      fetchImpl: async (_input, init) => {
        expect(new Headers(init?.headers).get('Prefer')).not.toBe(
          'outlook.body-content-type="text"',
        )
        return json({ ...message, toRecipients: [], body: { contentType, content } })
      },
    })
      .create('graph')
      .mailbox.get(session, { folder: 'inbox', messageId: 'fixture_id' }, signal())

  it('preserves formatting but removes active content, resource loads and navigation', async () => {
    const result = await read(
      '<style>body{background:url(https://tracker.test)}</style><script>alert(1)</script>' +
        '<h2>Hello</h2><p><b>Strong</b> &amp; <em>clear</em></p>' +
        '<a href="https://evil.test" target="_top" download ping="https://tracker.test">Link</a>' +
        '<img src="https://tracker.test/pixel" srcset="https://tracker.test/2" onerror="alert(1)">' +
        '<form action="https://evil.test"><input name="token"></form><iframe srcdoc="evil"></iframe>' +
        '<svg><a xlink:href="javascript:alert(1)">vector</a></svg><div style="position:fixed" onclick="alert(1)">Text</div>',
    )
    expect(result.html).toContain('<h2>Hello</h2>')
    expect(result.html).toContain('<b>Strong</b>')
    expect(result.html).not.toMatch(
      /script|style=|href|src|ping|target|download|onerror|onclick|form|input|iframe|svg|tracker\.test|evil\.test/i,
    )
    expect(result.body).toContain('Hello')
    expect(result.body).not.toContain('alert(1)')
    expect(result.truncated).toBe(false)
  })

  it('bounds serialized safe HTML and plain text independently without breaking UTF-8', async () => {
    const result = await read(`<p>${'\u4f60'.repeat(60_000)}</p>`)
    expect(Buffer.byteLength(result.html!)).toBeLessThanOrEqual(128 * 1024)
    expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(64 * 1024)
    expect(result.html).not.toContain('\ufffd')
    expect(result.body).not.toContain('\ufffd')
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024 * 1024)
  })

  it('keeps literal text as text with no invented HTML', async () => {
    const result = await read('<p>A literal text body</p>', 'text')
    expect(result.body).toBe('<p>A literal text body</p>')
    expect(result.html).toBeNull()
  })
})
