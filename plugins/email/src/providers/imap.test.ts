import { EventEmitter } from 'node:events'
import type {
  FetchMessageObject,
  FetchQueryObject,
  ImapFlowOptions,
  ListResponse,
  MailboxObject,
} from 'imapflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicrosoftEmailFactory, type ImapClient } from './microsoft.js'

const session = { email: 'reader@example.test', accessToken: 'fixture-access' }
const signal = () => new AbortController().signal
const metadata = (uid: number): FetchMessageObject => ({
  seq: uid,
  uid,
  flags: new Set(uid % 2 ? [] : ['\\Seen']),
  envelope: {
    subject: `Message ${uid}`,
    from: [{ name: 'Sender', address: 'sender@example.test' }],
    to: [{ name: 'Reader', address: session.email }],
  },
  internalDate: new Date('2026-11-12T02:00:00Z'),
  bodyStructure: { type: 'text/plain' },
  size: 100,
})
const folder: ListResponse = {
  path: 'Localized/Junk',
  pathAsListed: 'Localized/Junk',
  name: 'Junk',
  delimiter: '/',
  parent: ['Localized'],
  parentPath: 'Localized',
  flags: new Set(['\\Junk']),
  specialUse: '\\Junk',
  specialUseSource: 'extension',
  listed: true,
  subscribed: true,
}

class FakeImap extends EventEmitter implements ImapClient {
  uidValidity = 777n
  uidNext = 46
  uids = Array.from({ length: 45 }, (_, index) => index + 1)
  source = Buffer.from(
    'From: Sender <sender@example.test>\r\nTo: Reader <reader@example.test>\r\nSubject: Hello\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA plain body',
  )
  folders = [folder]
  connect = vi.fn(async () => {})
  close = vi.fn(() => {})
  list = vi.fn(async () => this.folders)
  mailboxOpen = vi.fn(
    async (path: string, options?: { readOnly?: boolean }): Promise<MailboxObject> => {
      expect(options?.readOnly).toBe(true)
      return {
        path,
        delimiter: '/',
        flags: new Set(),
        uidValidity: this.uidValidity,
        uidNext: this.uidNext,
        exists: this.uids.length,
        readOnly: true,
      }
    },
  )
  search = vi.fn(async (query: { uid: string }, options?: { uid?: boolean }) => {
    expect(options?.uid).toBe(true)
    const bound = Number(query.uid.split(':')[1])
    return this.uids.filter((uid) => uid <= bound)
  })
  fetchAll = vi.fn(
    async (range: string, query: FetchQueryObject, options?: { uid?: boolean }) => {
      expect(options?.uid).toBe(true)
      expect(query.source).toBeUndefined()
      return range.split(',').map(Number).reverse().map(metadata)
    },
  )
  fetchOne = vi.fn(
    async (uid: number, query: FetchQueryObject, options?: { uid?: boolean }) => {
      expect(options?.uid).toBe(true)
      return {
        ...metadata(uid),
        size: this.source.length,
        ...(query.source ? { source: this.source } : {}),
      }
    },
  )
}

const create = (client = new FakeImap(), options: { proxy?: string } = {}) => {
  const imapClientFactory = vi.fn<(options: ImapFlowOptions) => ImapClient>(() => client)
  const factory = new MicrosoftEmailFactory({ ...options, imapClientFactory })
  return { client, factory, imapClientFactory, mailbox: factory.create('imap').mailbox }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('OAuth IMAP mailbox', () => {
  it('uses TLS, OAuth only, read-only selection and bounded quiet connections', async () => {
    const { mailbox, client, imapClientFactory } = create()
    const page = await mailbox.list(session, { folder: 'inbox' }, signal())
    expect(imapClientFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'outlook.office365.com',
        port: 993,
        secure: true,
        auth: { user: session.email, accessToken: session.accessToken },
        logger: false,
        logRaw: false,
        disableAutoIdle: true,
        connectionTimeout: 30_000,
        socketTimeout: 30_000,
        maxLiteralSize: 2 * 1024 * 1024,
      }),
    )
    expect(client.mailboxOpen).toHaveBeenCalledWith('INBOX', { readOnly: true })
    expect(page.items).toHaveLength(20)
    expect(page.items.map((item) => item.subject)).toEqual(
      Array.from({ length: 20 }, (_, index) => `Message ${45 - index}`),
    )
    expect(page.items[0]).toMatchObject({
      from: { name: 'Sender', address: 'sender@example.test' },
      receivedAt: '2026-11-12T02:00:00.000Z',
      isRead: false,
      hasAttachments: false,
      preview: '',
    })
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it('discovers junk through special-use LIST without guessing an English path', async () => {
    const { mailbox, client } = create()
    await mailbox.list(session, { folder: 'junkemail' }, signal())
    expect(client.mailboxOpen).toHaveBeenCalledWith('Localized/Junk', { readOnly: true })
  })

  it('fails explicitly when LIST has no junk folder', async () => {
    const { mailbox, client } = create()
    client.folders = []
    await expect(
      mailbox.list(session, { folder: 'junkemail' }, signal()),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    expect(client.mailboxOpen).not.toHaveBeenCalled()
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it('does not treat a name-inferred junk folder as a server special-use flag', async () => {
    const { mailbox, client } = create()
    client.folders = [{ ...folder, flags: new Set(), specialUseSource: 'name' }]
    await expect(
      mailbox.list(session, { folder: 'junkemail' }, signal()),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    expect(client.mailboxOpen).not.toHaveBeenCalled()
  })

  it('keeps pagination on the first UID snapshot when newer messages arrive', async () => {
    const { mailbox, client } = create()
    const first = await mailbox.list(session, { folder: 'inbox' }, signal())
    client.uids.push(46, 47)
    client.uidNext = 48
    const second = await mailbox.list(
      session,
      { folder: 'inbox', cursor: first.nextCursor! },
      signal(),
    )
    expect(second.items.map((item) => item.subject)).toEqual(
      Array.from({ length: 20 }, (_, index) => `Message ${25 - index}`),
    )
    const third = await mailbox.list(
      session,
      { folder: 'inbox', cursor: second.nextCursor! },
      signal(),
    )
    expect(third.items.map((item) => item.subject)).toEqual([
      'Message 5',
      'Message 4',
      'Message 3',
      'Message 2',
      'Message 1',
    ])
    expect(third.nextCursor).toBeNull()
  })

  it('rejects cross-folder and cross-account cursors before opening a connection', async () => {
    const { mailbox, imapClientFactory } = create()
    const first = await mailbox.list(session, { folder: 'inbox' }, signal())
    await expect(
      mailbox.list(session, { folder: 'junkemail', cursor: first.nextCursor! }, signal()),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    await expect(
      mailbox.list(
        { ...session, email: 'other@example.test' },
        {
          folder: 'inbox',
          cursor: first.nextCursor!,
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(imapClientFactory).toHaveBeenCalledTimes(1)
  })

  it('rejects a changed UIDVALIDITY on both cursors and message IDs', async () => {
    const { mailbox, client } = create()
    const first = await mailbox.list(session, { folder: 'inbox' }, signal())
    client.uidValidity = 778n
    await expect(
      mailbox.list(session, { folder: 'inbox', cursor: first.nextCursor! }, signal()),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    await expect(
      mailbox.get(session, { folder: 'inbox', messageId: first.items[0]!.id }, signal()),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(client.fetchOne).not.toHaveBeenCalled()
  })

  it('uses stable UID IDs across factory instances and fetches detail by UID', async () => {
    const { mailbox } = create()
    const first = await mailbox.list(session, { folder: 'inbox' }, signal())
    const { mailbox: other, client } = create()
    const again = await other.list(session, { folder: 'inbox' }, signal())
    expect(again.items[0]!.id).toBe(first.items[0]!.id)
    const detail = await other.get(
      session,
      { folder: 'inbox', messageId: first.items[0]!.id },
      signal(),
    )
    expect(detail.id).toBe(first.items[0]!.id)
    expect(detail.body).toBe('A plain body')
    expect(detail.to).toEqual([{ name: 'Reader', address: session.email }])
    expect(detail.truncated).toBe(false)
    expect(client.fetchOne).toHaveBeenCalledWith(
      45,
      expect.objectContaining({
        source: { start: 0, maxLength: 2 * 1024 * 1024 },
      }),
      { uid: true },
    )
  })

  it('fails for missing and mismatched messages instead of returning blank detail', async () => {
    const { mailbox, client } = create()
    const first = await mailbox.list(session, { folder: 'inbox' }, signal())
    client.fetchOne.mockResolvedValueOnce({ ...metadata(44), size: 100 })
    await expect(
      mailbox.get(session, { folder: 'inbox', messageId: first.items[0]!.id }, signal()),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })

  it('refuses large MIME sources before downloading their body', async () => {
    const { mailbox, client } = create()
    const first = await mailbox.list(session, { folder: 'inbox' }, signal())
    client.fetchOne.mockResolvedValueOnce({ ...metadata(45), size: 2 * 1024 * 1024 + 1 })
    await expect(
      mailbox.get(session, { folder: 'inbox', messageId: first.items[0]!.id }, signal()),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    expect(client.fetchOne).toHaveBeenCalledTimes(1)
  })

  it('prefers the MIME text alternative and never emits HTML or attachment data', async () => {
    const { mailbox, client } = create()
    client.source = Buffer.from(
      [
        'From: Sender <sender@example.test>',
        'To: Reader <reader@example.test>',
        'Subject: Alternatives',
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary=fixture',
        '',
        '--fixture',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Use this text.',
        '--fixture',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Ignore this HTML</p><img src="https://tracker.test/pixel">',
        '--fixture--',
      ].join('\r\n'),
    )
    const page = await mailbox.list(session, { folder: 'inbox' }, signal())
    const detail = await mailbox.get(
      session,
      { folder: 'inbox', messageId: page.items[0]!.id },
      signal(),
    )
    expect(detail.body.trim()).toBe('Use this text.')
    expect(detail).not.toHaveProperty('html')
    expect(detail).not.toHaveProperty('attachments')
  })

  it('converts HTML MIME with the same safe text and UTF-8 bounds as Graph', async () => {
    const { mailbox, client } = create()
    client.source = Buffer.from(
      'MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' +
        '<style>hidden</style><script>secret()</script><p>' +
        '\u4f60'.repeat(25_000) +
        '</p>',
    )
    const page = await mailbox.list(session, { folder: 'inbox' }, signal())
    const detail = await mailbox.get(
      session,
      { folder: 'inbox', messageId: page.items[0]!.id },
      signal(),
    )
    expect(detail.body).toBe('\u4f60'.repeat(21_845))
    expect(detail.truncated).toBe(true)
  })

  it('rejects malformed search responses instead of reporting an empty folder', async () => {
    const { mailbox, client } = create()
    client.search.mockResolvedValueOnce([0, -1])
    await expect(
      mailbox.list(session, { folder: 'inbox' }, signal()),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })
})

describe('IMAP proxy and lifetime', () => {
  it.each([
    ['http://127.0.0.1:8888', 'http://127.0.0.1:8888/'],
    [
      'https://user:pass@proxy.example.test:8443',
      'https://user:pass@proxy.example.test:8443/',
    ],
    ['socks5://127.0.0.1:1080', 'socks5://127.0.0.1:1080'],
    ['socks5h://proxy.example.test:1080', 'socks5://proxy.example.test:1080'],
  ])('inherits proxy %s without falling back to direct', async (proxy, expected) => {
    vi.stubEnv('NEXUS_NETWORK_PROXY', proxy)
    const { mailbox, imapClientFactory } = create()
    await mailbox.list(session, { folder: 'inbox' }, signal())
    expect(imapClientFactory.mock.calls[0]![0].proxy).toBe(expected)
  })

  it('uses an explicitly injected proxy in preference to the inherited one', async () => {
    vi.stubEnv('NEXUS_NETWORK_PROXY', 'socks5://inherited.example.test:1080')
    const { mailbox, imapClientFactory } = create(new FakeImap(), {
      proxy: 'http://127.0.0.1:8888',
    })
    await mailbox.list(session, { folder: 'inbox' }, signal())
    expect(imapClientFactory.mock.calls[0]![0].proxy).toBe('http://127.0.0.1:8888/')
  })

  it.each([
    'ftp://proxy.example.test:21',
    'socks4://127.0.0.1:1080',
    'not-a-proxy',
    'http://proxy.example.test/path',
    'http://proxy.example.test/?token=secret',
    'socks5://proxy.example.test:0',
    'http://proxy.example.test/#fragment',
  ])('rejects invalid proxy %s without any network', (proxy) => {
    const imapClientFactory = vi.fn()
    expect(() =>
      new MicrosoftEmailFactory({ proxy, imapClientFactory }).create('imap'),
    ).toThrow(expect.objectContaining({ code: 'NOT_CONFIGURED' }))
    expect(imapClientFactory).not.toHaveBeenCalled()
  })

  it('does not retry a failed proxy with another connection', async () => {
    const { mailbox, client, imapClientFactory } = create(new FakeImap(), {
      proxy: 'socks5://127.0.0.1:1080',
    })
    client.connect.mockRejectedValueOnce(new Error('proxy credentials fixture-access'))
    await expect(
      mailbox.list(session, { folder: 'inbox' }, signal()),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    expect(imapClientFactory).toHaveBeenCalledTimes(1)
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ authenticationFailed: true }, 'AUTH_FAILED'],
    [{ serverResponseCode: 'NOPERM' }, 'PERMISSION_DENIED'],
    [{ serverResponseCode: 'NOPERM', authenticationFailed: true }, 'PERMISSION_DENIED'],
    [{ serverResponseCode: 'AUTHENTICATIONFAILED' }, 'AUTH_FAILED'],
    [{ serverResponseCode: 'AUTHORIZATIONFAILED' }, 'PERMISSION_DENIED'],
    [
      { serverResponseCode: 'AUTHORIZATIONFAILED', authenticationFailed: true },
      'PERMISSION_DENIED',
    ],
    [{ serverResponseCode: 'NOAUTH' }, 'AUTH_FAILED'],
    [{ responseCode: 'NOPERM' }, 'UNAVAILABLE'],
    [{ code: 'CONNECT_TIMEOUT' }, 'TIMEOUT'],
  ])('maps safe structured IMAP failures %j', async (properties, code) => {
    const { mailbox, client } = create()
    client.connect.mockRejectedValueOnce(
      Object.assign(new Error('raw token fixture-access'), properties),
    )
    const error = await mailbox
      .list(session, { folder: 'inbox' }, signal())
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code })
    expect(String(error)).not.toMatch(/raw token|fixture-access/)
  })

  it('closes stalled connections immediately on cancellation', async () => {
    const { mailbox, client } = create()
    client.connect.mockImplementationOnce(async () => new Promise<void>(() => {}))
    const controller = new AbortController()
    const task = mailbox.list(session, { folder: 'inbox' }, controller.signal)
    const check = expect(task).rejects.toMatchObject({ code: 'CANCELLED' })
    controller.abort(new Error('private reason'))
    await check
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it('closes stalled connections on the operation deadline', async () => {
    vi.useFakeTimers()
    const { mailbox, client } = create()
    client.connect.mockImplementationOnce(async () => new Promise<void>(() => {}))
    const task = mailbox.list(session, { folder: 'inbox' }, signal())
    const check = expect(task).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(30_001)
    await check
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it('handles emitted connection errors without logging or leaving a live client', async () => {
    const { mailbox, client } = create()
    client.connect.mockImplementationOnce(async () => new Promise<void>(() => {}))
    const task = mailbox.list(session, { folder: 'inbox' }, signal())
    const check = expect(task).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    client.emit('error', new Error('fixture-access'))
    await check
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it('does not resume IMAP commands if a failed connection resolves late', async () => {
    const { mailbox, client } = create()
    let finish: () => void = () => {}
    client.connect.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const task = mailbox.list(session, { folder: 'inbox' }, signal())
    const check = expect(task).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    client.emit('error', new Error('connection failed'))
    await check
    finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(client.mailboxOpen).not.toHaveBeenCalled()
  })
})
