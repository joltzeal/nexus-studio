import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicrosoftEmailFactory } from './microsoft.js'

const credentials = {
  email: 'reader@example.test',
  clientId: 'e72999aa-1f9d-4509-9efc-053d081a133c',
  refreshToken: 'fixture-refresh',
}
const session = { email: credentials.email, accessToken: 'fixture-access' }
const signal = () => new AbortController().signal
const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
const graphMessage = (id = 'AAMk_fixture') => ({
  id,
  subject: 'A message',
  from: { emailAddress: { name: 'Sender', address: 'sender@example.test' } },
  receivedDateTime: '2026-11-12T02:00:00Z',
  isRead: false,
  hasAttachments: false,
  bodyPreview: 'Preview',
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Microsoft OAuth', () => {
  it.each([
    ['graph', 'https://graph.microsoft.com/.default'],
    ['imap', 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access'],
  ] as const)(
    'refreshes %s using only modern OAuth and returns rotation',
    async (transport, scope) => {
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        expect(String(input)).toBe(
          'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        )
        expect(init?.method).toBe('POST')
        expect(init?.redirect).toBe('error')
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        expect(new URLSearchParams(init?.body as string)).toEqual(
          new URLSearchParams({
            client_id: credentials.clientId,
            refresh_token: credentials.refreshToken,
            grant_type: 'refresh_token',
            scope,
          }),
        )
        return json({
          token_type: 'Bearer',
          access_token: 'next-access',
          refresh_token: 'next-refresh',
          expires_in: 3600,
          ignored: 'not-a-dto-field',
        })
      })
      const provider = new MicrosoftEmailFactory({ fetchImpl }).create(transport)
      expect(await provider.tokens.refresh(credentials, signal())).toEqual({
        accessToken: 'next-access',
        refreshToken: 'next-refresh',
        expiresIn: 3600,
      })
    },
  )

  it('retains absent rotation as an absent field', async () => {
    const provider = new MicrosoftEmailFactory({
      fetchImpl: async () => json({ access_token: 'next-access', expires_in: 60 }),
    }).create('graph')
    expect(await provider.tokens.refresh(credentials, signal())).toEqual({
      accessToken: 'next-access',
      expiresIn: 60,
    })
  })

  it.each(['invalid_grant', 'invalid_client', 'interaction_required'])(
    'maps %s without exposing server descriptions or credentials',
    async (error) => {
      const provider = new MicrosoftEmailFactory({
        fetchImpl: async () =>
          json({ error, error_description: `secret ${credentials.refreshToken}` }, 400),
      }).create('graph')
      await expect(provider.tokens.refresh(credentials, signal())).rejects.toMatchObject({
        code: 'AUTH_FAILED',
        retryable: false,
      })
      await expect(provider.tokens.refresh(credentials, signal())).rejects.not.toThrow(
        /secret|fixture-refresh|invalid_grant|invalid_client|interaction_required/,
      )
    },
  )

  it.each([
    [{}, 200],
    [{ access_token: 'x' }, 200],
    [{ access_token: 'x', expires_in: 0 }, 200],
    [{ access_token: 'x', expires_in: '3600' }, 200],
    [{ access_token: 'x', expires_in: 60, refresh_token: '' }, 200],
  ])('rejects malformed successful token responses: %j', async (body, status) => {
    const provider = new MicrosoftEmailFactory({
      fetchImpl: async () => json(body, status),
    }).create('graph')
    await expect(provider.tokens.refresh(credentials, signal())).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })

  it.each([
    [429, '99999999', 'RATE_LIMITED', 3_600_000],
    [503, '2', 'UNAVAILABLE', 2_000],
    [429, '0', 'RATE_LIMITED', 1_000],
  ])('bounds Retry-After on status %i', async (status, retry, code, retryAfterMs) => {
    const provider = new MicrosoftEmailFactory({
      fetchImpl: async () => json({}, status, { 'Retry-After': retry }),
    }).create('graph')
    await expect(provider.tokens.refresh(credentials, signal())).rejects.toMatchObject({
      code,
      retryAfterMs,
      retryable: true,
    })
  })

  it('honors Retry-After on transient OAuth error responses', async () => {
    const tokens = new MicrosoftEmailFactory({
      fetchImpl: async () =>
        json(
          { error: 'temporarily_unavailable', error_description: 'private server body' },
          400,
          { 'Retry-After': '120' },
        ),
    }).create('graph').tokens
    await expect(tokens.refresh(credentials, signal())).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      retryable: true,
      retryAfterMs: 120_000,
    })
  })
})

describe('Graph mailbox', () => {
  it('requests the selected folder with twenty newest summaries and strips extra fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin + url.pathname).toBe(
        'https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages',
      )
      expect(url.searchParams.get('$top')).toBe('20')
      expect(url.searchParams.get('$orderby')).toBe('receivedDateTime desc')
      expect(url.searchParams.get('$select')?.split(',')).toEqual([
        'id',
        'subject',
        'from',
        'receivedDateTime',
        'isRead',
        'hasAttachments',
        'bodyPreview',
      ])
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer fixture-access',
      )
      return json({ value: [{ ...graphMessage(), secretExtra: 'discard' }] })
    })
    const provider = new MicrosoftEmailFactory({ fetchImpl }).create('graph')
    expect(
      await provider.mailbox.list(session, { folder: 'junkemail' }, signal()),
    ).toEqual({
      items: [
        {
          id: 'AAMk_fixture',
          subject: 'A message',
          from: { name: 'Sender', address: 'sender@example.test' },
          receivedAt: '2026-11-12T02:00:00.000Z',
          isRead: false,
          hasAttachments: false,
          preview: 'Preview',
        },
      ],
      nextCursor: null,
    })
  })

  it('preserves the whole continuation query across paired factory creations', async () => {
    const query = '?$skip=20&$top=20&$select=id%2Csubject&$skiptoken=abc%2Bdef%3D%3D'
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          value: [graphMessage()],
          '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages${query}`,
        }),
      )
      .mockImplementationOnce(async (input) => {
        expect(new URL(String(input)).search).toBe(query)
        return json({ value: [] })
      })
    const factory = new MicrosoftEmailFactory({ fetchImpl })
    const first = await factory
      .create('graph')
      .mailbox.list(session, { folder: 'inbox' }, signal())
    expect(first.nextCursor).toBeTypeOf('string')
    expect(first.nextCursor).not.toContain('https://')
    await expect(
      factory
        .create('graph')
        .mailbox.list(session, { folder: 'inbox', cursor: first.nextCursor! }, signal()),
    ).resolves.toEqual({ items: [], nextCursor: null })
  })

  it('follows the canonical OData folder selector without rewriting the nextLink', async () => {
    const nextLink =
      "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages?$skiptoken=opaque%2Bvalue&$top=20"
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ value: [graphMessage()], '@odata.nextLink': nextLink }),
      )
      .mockResolvedValueOnce(json({ value: [] }))
    const provider = new MicrosoftEmailFactory({ fetchImpl }).create('graph')
    const first = await provider.mailbox.list(session, { folder: 'inbox' }, signal())
    await provider.mailbox.list(
      session,
      { folder: 'inbox', cursor: first.nextCursor! },
      signal(),
    )
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(nextLink)
  })

  it.each([
    'https://graph.microsoft.com.evil.test/v1.0/me/mailFolders/inbox/messages?$skip=20',
    'https://graph.microsoft.com/v1.0/me/messages?$skip=20',
    'https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages?$skip=20',
    'http://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=20',
    'https://user@graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=20',
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=20#fragment',
  ])('rejects unsafe nextLink %s', async (nextLink) => {
    const mailbox = new MicrosoftEmailFactory({
      fetchImpl: async () => json({ value: [], '@odata.nextLink': nextLink }),
    }).create('graph').mailbox
    await expect(
      mailbox.list(session, { folder: 'inbox' }, signal()),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })

  it('rejects forged, cross-folder and cross-account cursors before sending a token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({
        value: [],
        '@odata.nextLink':
          'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=20',
      }),
    )
    const mailbox = new MicrosoftEmailFactory({ fetchImpl }).create('graph').mailbox
    const { nextCursor } = await mailbox.list(session, { folder: 'inbox' }, signal())
    for (const [account, folder, cursor] of [
      [session, 'inbox', 'https://evil.test'],
      [session, 'junkemail', nextCursor],
      [{ ...session, email: 'other@example.test' }, 'inbox', nextCursor],
      [session, 'inbox', nextCursor! + 'changed'],
    ] as const) {
      await expect(
        mailbox.list(account, { folder, cursor: cursor! }, signal()),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      })
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    {},
    { value: null },
    { value: [{}] },
    { value: [{ ...graphMessage(), isRead: 'false' }] },
    { value: [{ ...graphMessage(), receivedDateTime: 'not-a-date' }] },
    { value: Array.from({ length: 21 }, (_, index) => graphMessage(`id_${index}`)) },
  ])(
    'fails on malformed list responses instead of returning an empty inbox',
    async (body) => {
      const mailbox = new MicrosoftEmailFactory({
        fetchImpl: async () => json(body),
      }).create('graph').mailbox
      await expect(
        mailbox.list(session, { folder: 'inbox' }, signal()),
      ).rejects.toMatchObject({
        code: 'PROTOCOL_ERROR',
      })
    },
  )

  it.each([
    [401, 'AUTH_FAILED'],
    [403, 'PERMISSION_DENIED'],
  ] as const)(
    'distinguishes status %i without trying another transport',
    async (status, code) => {
      const fetchImpl = vi.fn<typeof fetch>(
        async () => new Response('server-body fixture-access', { status }),
      )
      const mailbox = new MicrosoftEmailFactory({ fetchImpl }).create('graph').mailbox
      await expect(
        mailbox.list(session, { folder: 'inbox' }, signal()),
      ).rejects.toMatchObject({
        code,
        retryable: false,
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    },
  )

  it('asks for text and safely converts returned HTML without script, style or remote image text', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe(
        '/v1.0/me/mailFolders/inbox/messages/AAMk_fixture',
      )
      expect(new Headers(init?.headers).get('Prefer')).toBe(
        'outlook.body-content-type="text"',
      )
      return json({
        ...graphMessage(),
        toRecipients: [{ emailAddress: { name: 'Reader', address: session.email } }],
        body: {
          contentType: 'html',
          content:
            '<style>hidden</style><p>Hello &amp; welcome</p><script>secret()</script><img src="https://tracker.test/pixel"><p>Second</p>',
        },
      })
    })
    const detail = await new MicrosoftEmailFactory({ fetchImpl })
      .create('graph')
      .mailbox.get(session, { folder: 'inbox', messageId: 'AAMk_fixture' }, signal())
    expect(detail.body).toBe('Hello & welcome\nSecond')
    expect(detail.to).toEqual([{ name: 'Reader', address: session.email }])
    expect(detail.truncated).toBe(false)
    expect(Object.keys(detail).sort()).toEqual([
      'body',
      'from',
      'hasAttachments',
      'id',
      'isRead',
      'preview',
      'receivedAt',
      'subject',
      'to',
      'truncated',
    ])
  })

  it('caps UTF-8 body bytes without cutting a multibyte character', async () => {
    const mailbox = new MicrosoftEmailFactory({
      fetchImpl: async () =>
        json({
          ...graphMessage(),
          toRecipients: [],
          body: { contentType: 'text', content: 'a'.repeat(65535) + '\u4f60tail' },
        }),
    }).create('graph').mailbox
    const detail = await mailbox.get(
      session,
      { folder: 'inbox', messageId: 'AAMk_fixture' },
      signal(),
    )
    expect(detail.body).toBe('a'.repeat(65535))
    expect(Buffer.byteLength(detail.body)).toBeLessThanOrEqual(65536)
    expect(detail.truncated).toBe(true)
  })

  it('rejects malformed detail rather than inventing a blank body', async () => {
    const mailbox = new MicrosoftEmailFactory({
      fetchImpl: async () => json({ ...graphMessage(), toRecipients: [] }),
    }).create('graph').mailbox
    await expect(
      mailbox.get(session, { folder: 'inbox', messageId: 'AAMk_fixture' }, signal()),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })
})

describe('bounded HTTP operations', () => {
  it('uses the host global fetch without replacing its inherited proxy', async () => {
    const inherited = vi.fn<typeof fetch>(async () => json({ value: [] }))
    vi.stubGlobal('fetch', inherited)
    await new MicrosoftEmailFactory()
      .create('graph')
      .mailbox.list(session, { folder: 'inbox' }, signal())
    expect(inherited).toHaveBeenCalledTimes(1)
  })

  it('cancels an uncooperative fetch and does not expose its abort reason', async () => {
    const controller = new AbortController()
    let passed: AbortSignal | null | undefined
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      passed = init?.signal
      return new Promise<Response>(() => {})
    })
    const task = new MicrosoftEmailFactory({ fetchImpl })
      .create('graph')
      .tokens.refresh(credentials, controller.signal)
    const check = expect(task).rejects.toMatchObject({ code: 'CANCELLED' })
    controller.abort(new Error('fixture-refresh must not leak'))
    await check
    expect(passed?.aborted).toBe(true)
  })

  it('discards a late response after cancellation instead of leaving its body reading', async () => {
    let finish: (response: Response) => void = () => {}
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const controller = new AbortController()
    const task = new MicrosoftEmailFactory({ fetchImpl })
      .create('graph')
      .tokens.refresh(credentials, controller.signal)
    const check = expect(task).rejects.toMatchObject({ code: 'CANCELLED' })
    controller.abort()
    await check
    let discarded = false
    finish(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            discarded = true
          },
        }),
      ),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(discarded).toBe(true)
  })

  it('does not start an already cancelled request', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const controller = new AbortController()
    controller.abort()
    await expect(
      new MicrosoftEmailFactory({ fetchImpl })
        .create('graph')
        .tokens.refresh(credentials, controller.signal),
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('times out both response headers and a stalled response body', async () => {
    vi.useFakeTimers()
    for (const fetchImpl of [
      (async () => new Promise<Response>(() => {})) as typeof fetch,
      (async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }))) as typeof fetch,
    ]) {
      const task = new MicrosoftEmailFactory({ fetchImpl })
        .create('graph')
        .tokens.refresh(credentials, signal())
      const check = expect(task).rejects.toMatchObject({
        code: 'TIMEOUT',
        retryable: true,
      })
      await vi.advanceTimersByTimeAsync(30_001)
      await check
    }
  })

  it('rejects oversized streamed JSON even without Content-Length', async () => {
    let cancelled = false
    const mailbox = new MicrosoftEmailFactory({
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    }).create('graph').mailbox
    await expect(
      mailbox.list(session, { folder: 'inbox' }, signal()),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    expect(cancelled).toBe(true)
  })

  it('sanitizes arbitrary network exceptions', async () => {
    const mailbox = new MicrosoftEmailFactory({
      fetchImpl: async () => {
        throw new Error('proxy://user:password fixture-access')
      },
    }).create('graph').mailbox
    await expect(
      mailbox.list(session, { folder: 'inbox' }, signal()),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    await expect(
      mailbox.list(session, { folder: 'inbox' }, signal()),
    ).rejects.not.toThrow(/password|fixture-access|proxy:\/\//)
  })
})
