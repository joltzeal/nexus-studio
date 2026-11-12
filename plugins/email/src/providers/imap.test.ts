import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  ImapFlow,
  type FetchMessageObject,
  type FetchQueryObject,
  type ImapFlowOptions,
  type ImapResponse,
  type ListResponse,
  type MailboxObject,
  type StatusObject,
} from 'imapflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmailService } from '../capabilities/email.js'
import { PluginFailure } from '../domain/errors.js'
import type { MailboxView, MailMessagePage } from '../domain/types.js'
import type { DispatchContext } from '../rpc/protocol.js'
import { createMemoryStore } from '../store/private-store.js'
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
  readonly readFlags = new Map<number, boolean>()
  connect = vi.fn(async () => {})
  close = vi.fn(() => {})
  list = vi.fn(async () => this.folders)
  mailboxOpen = vi.fn(
    async (path: string, options?: { readOnly?: boolean }): Promise<MailboxObject> => {
      return {
        path,
        delimiter: '/',
        flags: new Set(),
        uidValidity: this.uidValidity,
        uidNext: this.uidNext,
        exists: this.uids.length,
        readOnly: options?.readOnly ?? true,
      }
    },
  )
  status = vi.fn(async (): Promise<StatusObject> => ({
    path: 'INBOX',
    messages: this.uids.length,
    unseen: this.uids.filter((uid) => !(this.readFlags.get(uid) ?? uid % 2 === 0)).length,
  }))
  search = vi.fn(
    async (query: { uid: string; seen?: boolean }, options?: { uid?: boolean }) => {
      expect(options?.uid).toBe(true)
      const bound = Number(query.uid.split(':')[1])
      return this.uids.filter(
        (uid) =>
          uid <= bound &&
          (query.seen === undefined ||
            (this.readFlags.get(uid) ?? uid % 2 === 0) === query.seen),
      )
    },
  )
  fetchAll = vi.fn(
    async (range: string, query: FetchQueryObject, options?: { uid?: boolean }) => {
      expect(options?.uid).toBe(true)
      expect(query.source).toBeUndefined()
      return range
        .split(',')
        .map(Number)
        .reverse()
        .map((uid) => ({
          ...metadata(uid),
          flags: new Set((this.readFlags.get(uid) ?? uid % 2 === 0) ? ['\\Seen'] : []),
        }))
    },
  )
  fetchOne = vi.fn(
    async (
      uid: number,
      query: FetchQueryObject,
      options?: { uid?: boolean },
    ): Promise<FetchMessageObject | false> => {
      expect(options?.uid).toBe(true)
      return {
        ...metadata(uid),
        flags: new Set((this.readFlags.get(uid) ?? uid % 2 === 0) ? ['\\Seen'] : []),
        size: this.source.length,
        ...(query.source ? { source: this.source } : {}),
      }
    },
  )
  messageFlagsAdd = vi.fn(async (uid: number) => {
    this.readFlags.set(uid, true)
    return true
  })
  messageFlagsRemove = vi.fn(async (uid: number) => {
    this.readFlags.set(uid, false)
    return true
  })
}

const create = (client = new FakeImap(), options: { proxy?: string } = {}) => {
  const imapClientFactory = vi.fn<(options: ImapFlowOptions) => ImapClient>(() => client)
  const factory = new MicrosoftEmailFactory({ ...options, imapClientFactory })
  return { client, factory, imapClientFactory, mailbox: factory.create('imap').mailbox }
}

const commandError = (code?: string) =>
  Object.assign(new Error('private command response fixture-access'), {
    responseStatus: 'NO',
    responseText: 'private command response [NOPERM] fixture-access',
    executedCommand: 'private command fixture-access',
    response: {
      tag: 'A1',
      command: 'NO',
      attributes: [
        ...(code ? [{ type: 'ATOM', section: [{ type: 'ATOM', value: code }] }] : []),
        { type: 'TEXT', value: 'private command response fixture-access' },
      ],
    },
  })

function createCommandFixture() {
  const state = new FakeImap()
  const errors = new Map<string, () => unknown>()
  const falseResults: string[] = []
  const commands: string[] = []
  const clients: { client: ImapFlow; exec: unknown }[] = []
  const listProbe = vi.fn(async () => state.list())
  const handlerError = vi.fn((error: unknown) => error)
  let precondition = false
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    throw new Error('HTTP must not be used by the IMAP command fixture')
  })
  const imapClientFactory = vi.fn((options: ImapFlowOptions) => {
    const client = new ImapFlow(options)
    // Keep the installed command handlers and public STATUS/flag methods; replace I/O.
    const handlers = Reflect.get(client, 'commands') as Map<
      string,
      (connection: ImapFlow, ...args: unknown[]) => Promise<unknown>
    >
    const exec = vi.fn(async function (
      this: ImapFlow,
      command: string,
      _attributes: unknown,
      options?: {
        untagged?: { STATUS?: (response: ImapResponse) => Promise<void> }
      },
    ) {
      expect(this).toBe(client)
      commands.push(command)
      const error = errors.get(command)
      if (error) throw error()
      if (command === 'STATUS') {
        const counts = await state.status()
        await options?.untagged?.STATUS?.({
          command: 'STATUS',
          attributes: [
            { type: 'ATOM', value: 'INBOX' },
            [
              { type: 'ATOM', value: 'MESSAGES' },
              { type: 'ATOM', value: String(counts.messages) },
              { type: 'ATOM', value: 'UNSEEN' },
              { type: 'ATOM', value: String(counts.unseen) },
            ],
          ],
        })
      }
      return { next() {} }
    })
    Reflect.set(client, 'exec', exec)
    Reflect.set(
      client,
      'run',
      async (command: string, ...args: unknown[]): Promise<unknown> => {
        if (command === 'LIST') {
          const error = errors.get(command)
          if (error) throw error()
          return listProbe()
        }
        const handler = handlers.get(command)
        if (!handler) throw new Error(`Unexpected fixture command: ${command}`)
        const result = await handler(client, ...args).catch((error: unknown) => {
          throw handlerError(error)
        })
        if (result === false) falseResults.push(command)
        return result
      },
    )
    vi.spyOn(client, 'connect').mockResolvedValue()
    vi.spyOn(client, 'close').mockImplementation(() => {})
    vi.spyOn(client, 'list').mockImplementation(async () => state.list())
    vi.spyOn(client, 'mailboxOpen').mockImplementation(async (path, options) => {
      const mailbox = await state.mailboxOpen(String(path), {
        readOnly: options?.readOnly === true,
      })
      client.mailbox = mailbox
      client.state = precondition
        ? client.states.NOT_AUTHENTICATED
        : client.states.SELECTED
      return mailbox
    })
    vi.spyOn(client, 'search').mockImplementation(async (query, options) =>
      state.search(
        {
          uid: String(query.uid),
          ...(query.seen === undefined ? {} : { seen: query.seen }),
        },
        { uid: options?.uid === true },
      ),
    )
    vi.spyOn(client, 'fetchAll').mockImplementation(async (range, query, options) =>
      state.fetchAll(String(range), query, { uid: options?.uid === true }),
    )
    vi.spyOn(client, 'fetchOne').mockImplementation(async (uid, query, options) =>
      state.fetchOne(Number(uid), query, { uid: options?.uid === true }),
    )
    clients.push({ client, exec })
    return client
  })
  const factory = new MicrosoftEmailFactory({ imapClientFactory, fetchImpl })
  return {
    factory,
    mailbox: factory.create('imap').mailbox,
    errors,
    commands,
    falseResults,
    clients,
    fetchImpl,
    listProbe,
    handlerError,
    setPrecondition: () => {
      precondition = true
    },
  }
}

async function createCommandService() {
  const fixture = createCommandFixture()
  const store = createMemoryStore()
  let clock = new Date('2026-11-12T01:00:00.000Z')
  const provider = fixture.factory.create('imap')
  const create = () =>
    new EmailService({
      store,
      providers: { get: () => provider },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      now: () => clock,
    })
  const service = create()
  const call = (target: EmailService, method: string, payload: unknown = {}) =>
    target.call({
      requestId: randomUUID(),
      capability: 'email.provider',
      method,
      payload,
      deadlineAt: Date.now() + 120_000,
      assertAlive() {},
      signal: signal(),
    } satisfies DispatchContext)
  const account = (await call(service, 'email.accounts.save', {
    provider: 'microsoft',
    transport: 'imap',
    email: session.email,
    clientId: '00000000-0000-4000-8000-000000000001',
    refreshToken: 'synthetic-refresh',
    password: '',
    enabled: true,
    note: '',
  })) as MailboxView
  const prepare = () =>
    store.mutate((document) => {
      const entry = document.accounts[0]!
      entry.accessToken = session.accessToken
      entry.accessExpiresAt = '2026-11-13T01:00:00.000Z'
      entry.nextRefreshAt = '2026-11-13T00:55:00.000Z'
      entry.status = 'active'
    })
  await prepare()
  return {
    ...fixture,
    account,
    service,
    create,
    prepare,
    call,
    advance: (minutes: number) => {
      clock = new Date(clock.getTime() + minutes * 60_000)
    },
    get: (target = service) =>
      call(target, 'email.accounts.get', { id: account.id }) as Promise<MailboxView>,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe.each(['STATUS', 'UID STORE'])(
  'installed ImapFlow %s false results',
  (command) => {
    it.each([
      ['parsed NOPERM', () => commandError('NOPERM'), 'PERMISSION_DENIED'],
      [
        'parsed AUTHORIZATIONFAILED',
        () => commandError('AUTHORIZATIONFAILED'),
        'PERMISSION_DENIED',
      ],
      [
        'parsed AUTHENTICATIONFAILED',
        () => commandError('AUTHENTICATIONFAILED'),
        'AUTH_FAILED',
      ],
      ['parsed NOAUTH', () => commandError('NOAUTH'), 'AUTH_FAILED'],
      [
        'enhanced NOPERM',
        () => Object.assign(commandError(), { serverResponseCode: 'NOPERM' }),
        'PERMISSION_DENIED',
      ],
      ['unclassified NO', () => commandError(), 'PROTOCOL_ERROR'],
      [
        'obsolete responseCode',
        () => Object.assign(commandError(), { responseCode: 'NOPERM' }),
        'PROTOCOL_ERROR',
      ],
    ] as const)(
      'classifies %s without retaining raw errors',
      async (_name, error, code) => {
        const fixture = createCommandFixture()
        const page = await fixture.mailbox.list(session, { folder: 'inbox' }, signal())
        fixture.errors.set(command, error)
        const result = await (
          command === 'STATUS'
            ? fixture.mailbox.list(session, { folder: 'inbox' }, signal())
            : fixture.mailbox.setRead(
                session,
                { folder: 'inbox', messageId: page.items[0]!.id, isRead: true },
                signal(),
              )
        ).catch((cause: unknown) => cause)
        expect(fixture.falseResults).toEqual([command === 'STATUS' ? 'STATUS' : 'STORE'])
        expect(result).toMatchObject({ code })
        expect(String(result) + JSON.stringify(result)).not.toMatch(
          /private command|fixture-access|responseText|executedCommand|serverResponseCode/,
        )
        expect(fixture.fetchImpl).not.toHaveBeenCalled()
        for (const { client, exec } of fixture.clients) {
          expect(Reflect.get(client, 'exec')).toBe(exec)
          expect(client.options).toMatchObject({
            logger: false,
            logRaw: false,
            emitLogs: false,
            disableAutoIdle: true,
          })
        }
      },
    )

    it('keeps a handler precondition false as a protocol error without a command rejection', async () => {
      const fixture = createCommandFixture()
      const page = await fixture.mailbox.list(session, { folder: 'inbox' }, signal())
      fixture.setPrecondition()
      const before = fixture.commands.length
      const operation =
        command === 'STATUS'
          ? fixture.mailbox.list(session, { folder: 'inbox' }, signal())
          : fixture.mailbox.setRead(
              session,
              { folder: 'inbox', messageId: page.items[0]!.id, isRead: true },
              signal(),
            )
      await expect(operation).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
      expect(fixture.commands).toHaveLength(before)
      expect(fixture.falseResults).toEqual([command === 'STATUS' ? 'STATUS' : 'STORE'])
    })
  },
)

describe('installed ImapFlow authorization lifecycle', () => {
  it.each([
    ['NOPERM', 'PERMISSION_DENIED'],
    ['AUTHORIZATIONFAILED', 'PERMISSION_DENIED'],
    ['AUTHENTICATIONFAILED', 'AUTH_FAILED'],
    ['NOAUTH', 'AUTH_FAILED'],
    [undefined, 'UNAVAILABLE'],
  ] as const)(
    'keeps STATUS %s classification through the empty-LIST derived NotFound',
    async (primary, code) => {
      const fixture = createCommandFixture()
      fixture.errors.set('STATUS', () => commandError(primary))
      fixture.listProbe.mockResolvedValue([])
      const error = await fixture.mailbox
        .list(session, { folder: 'inbox' }, signal())
        .catch((cause: unknown) => cause)
      expect(error).toMatchObject({ code })
      expect(fixture.listProbe).toHaveBeenCalledTimes(1)
      expect(fixture.handlerError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'NotFound',
          response: expect.objectContaining({ responseStatus: 'NO' }),
        }),
      )
      expect(fixture.falseResults).toEqual([])
      expect(String(error) + JSON.stringify(error)).not.toMatch(
        /private command|fixture-access|responseText|executedCommand|Mailbox doesn't exist/,
      )
      for (const { client, exec } of fixture.clients) {
        expect(Reflect.get(client, 'exec')).toBe(exec)
      }
    },
  )

  it.each([
    ['unrelated exception', () => new Error('private fixture-access'), 'UNAVAILABLE'],
    [
      'ordinary NotFound',
      () => Object.assign(new Error('private fixture-access'), { code: 'NotFound' }),
      'UNAVAILABLE',
    ],
    [
      'unclassified derived NotFound',
      () =>
        Object.assign(new Error('private fixture-access'), {
          code: 'NotFound',
          response: commandError(),
        }),
      'UNAVAILABLE',
    ],
    [
      'NotFound with no NO rejection',
      () =>
        Object.assign(new Error('private fixture-access'), {
          code: 'NotFound',
          response: { serverResponseCode: 'NOPERM' },
        }),
      'UNAVAILABLE',
    ],
    ['cancellation', () => new PluginFailure('CANCELLED', 'Cancelled'), 'CANCELLED'],
    ['timeout', () => new PluginFailure('TIMEOUT', 'Timed out'), 'TIMEOUT'],
    [
      'transport timeout',
      () =>
        Object.assign(new Error('private fixture-access'), { code: 'CONNECT_TIMEOUT' }),
      'TIMEOUT',
    ],
  ] as const)(
    'preserves %s instead of promoting captured STATUS authorization',
    async (_label, cause, code) => {
      const fixture = createCommandFixture()
      fixture.errors.set('STATUS', () => commandError('NOPERM'))
      fixture.listProbe.mockResolvedValue([])
      fixture.handlerError.mockImplementation(cause)
      await expect(
        fixture.mailbox.list(session, { folder: 'inbox' }, signal()),
      ).rejects.toMatchObject({ code })
      expect(fixture.handlerError).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'NotFound' }),
      )
      for (const { client, exec } of fixture.clients) {
        expect(Reflect.get(client, 'exec')).toBe(exec)
      }
    },
  )

  it.each(['cancel', 'timeout'] as const)(
    'keeps %s precedence while an empty LIST probe is pending',
    async (outcome) => {
      if (outcome === 'timeout') vi.useFakeTimers()
      const fixture = createCommandFixture()
      const controller = new AbortController()
      let complete!: (folders: ListResponse[]) => void
      fixture.errors.set('STATUS', () => commandError('NOPERM'))
      fixture.listProbe.mockImplementationOnce(
        async () =>
          new Promise<ListResponse[]>((resolve) => {
            complete = resolve
          }),
      )
      const task = fixture.mailbox.list(session, { folder: 'inbox' }, controller.signal)
      const check = expect(task).rejects.toMatchObject({
        code: outcome === 'cancel' ? 'CANCELLED' : 'TIMEOUT',
      })
      await vi.waitFor(() => expect(fixture.listProbe).toHaveBeenCalledTimes(1))
      if (outcome === 'cancel') controller.abort(new Error('private fixture-access'))
      else await vi.advanceTimersByTimeAsync(30_001)
      await check
      complete([])
      await vi.waitFor(() => {
        expect(fixture.handlerError).toHaveBeenCalledWith(
          expect.objectContaining({ code: 'NotFound' }),
        )
        for (const { client, exec } of fixture.clients) {
          expect(Reflect.get(client, 'exec')).toBe(exec)
          expect(client.close).toHaveBeenCalledTimes(1)
        }
      })
    },
  )

  it.each([
    ['NOPERM', 'NOAUTH', 'PERMISSION_DENIED'],
    [undefined, 'NOPERM', 'PROTOCOL_ERROR'],
  ] as const)(
    'keeps STATUS %s separate from its failing LIST probe %s',
    async (primary, probe, code) => {
      const fixture = createCommandFixture()
      fixture.errors.set('STATUS', () => commandError(primary))
      fixture.errors.set('LIST', () => commandError(probe))
      await expect(
        fixture.mailbox.list(session, { folder: 'inbox' }, signal()),
      ).rejects.toMatchObject({ code })
      expect(fixture.falseResults).toEqual(['STATUS'])
    },
  )

  it('does not reuse a captured denial for a later precondition false', async () => {
    const fixture = createCommandFixture()
    const page = await fixture.mailbox.list(session, { folder: 'inbox' }, signal())
    const input = { folder: 'inbox', messageId: page.items[0]!.id, isRead: true } as const
    fixture.errors.set('UID STORE', () => commandError('NOPERM'))
    await expect(fixture.mailbox.setRead(session, input, signal())).rejects.toMatchObject(
      {
        code: 'PERMISSION_DENIED',
      },
    )
    fixture.errors.delete('UID STORE')
    fixture.setPrecondition()
    await expect(fixture.mailbox.setRead(session, input, signal())).rejects.toMatchObject(
      {
        code: 'PROTOCOL_ERROR',
      },
    )
  })

  it.each([false, true])(
    'persists STATUS NOPERM with empty LIST=%s as terminal across restart until credentials change',
    async (emptyList) => {
      const fixture = await createCommandService()
      let restarted: EmailService | undefined
      try {
        if (emptyList) fixture.listProbe.mockResolvedValueOnce([])
        fixture.errors.set('STATUS', () => commandError('NOPERM'))
        await fixture.service.tick()
        expect((await fixture.get()).reception).toMatchObject({
          lastErrorCode: 'PERMISSION_DENIED',
          nextCheckAt: null,
          lastCheckedAt: null,
        })
        expect(fixture.commands).toEqual(['STATUS'])
        expect(fixture.falseResults).toEqual(emptyList ? [] : ['STATUS'])
        await fixture.service.stop()
        restarted = fixture.create()
        fixture.advance(120)
        await restarted.tick()
        expect((await fixture.get(restarted)).reception.nextCheckAt).toBeNull()
        expect(fixture.commands).toEqual(['STATUS'])
        await fixture.call(restarted, 'email.accounts.save', {
          id: fixture.account.id,
          provider: 'microsoft',
          transport: 'imap',
          email: session.email,
          clientId: '00000000-0000-4000-8000-000000000001',
          refreshToken: 'synthetic-new-refresh',
          password: '',
          enabled: true,
          note: '',
        })
        await fixture.prepare()
        fixture.errors.delete('STATUS')
        await restarted.tick()
        expect((await fixture.get(restarted)).reception).toMatchObject({
          lastErrorCode: null,
          inbox: { total: 45, unread: 23 },
          junkemail: { total: 45, unread: 23 },
        })
        expect(fixture.commands).toEqual(['STATUS', 'STATUS', 'STATUS'])
        expect(fixture.fetchImpl).not.toHaveBeenCalled()
      } finally {
        await fixture.service.stop()
        await restarted?.stop()
      }
    },
  )

  it('keeps unclassified STATUS and empty LIST on transient reception backoff', async () => {
    const fixture = await createCommandService()
    try {
      fixture.errors.set('STATUS', () => commandError())
      fixture.listProbe.mockResolvedValue([])
      await fixture.service.tick()
      expect((await fixture.get()).reception).toMatchObject({
        lastErrorCode: 'UNAVAILABLE',
        nextCheckAt: '2026-11-12T01:01:00.000Z',
      })
      await fixture.service.tick()
      expect(fixture.commands).toEqual(['STATUS'])
      fixture.advance(1)
      await fixture.service.tick()
      expect(fixture.commands).toEqual(['STATUS', 'STATUS'])
      expect((await fixture.get()).reception).toMatchObject({
        lastErrorCode: 'UNAVAILABLE',
        nextCheckAt: '2026-11-12T01:03:00.000Z',
      })
    } finally {
      await fixture.service.stop()
    }
  })

  it.each([true, false])(
    'returns STORE NOPERM in the isRead=%s receipt while detail/list/reception remain available',
    async (isRead) => {
      const fixture = await createCommandService()
      try {
        await fixture.service.tick()
        const reception = (await fixture.get()).reception
        const query = {
          accountId: fixture.account.id,
          expectedEmail: session.email,
          folder: 'inbox',
        }
        const page = (await fixture.call(
          fixture.service,
          'email.messages.list',
          query,
        )) as MailMessagePage
        const message = page.items.find((item) => item.isRead !== isRead)!
        fixture.errors.set('UID STORE', () => commandError('NOPERM'))
        const receipt = await fixture.call(fixture.service, 'email.messages.read', {
          ...query,
          messageIds: [message.id],
          isRead,
        })
        expect(receipt).toEqual({
          updatedIds: [],
          failures: [{ messageId: message.id, code: 'PERMISSION_DENIED' }],
          isRead,
        })
        expect((await fixture.get()).reception).toEqual(reception)
        expect((await fixture.get()).status).toBe('active')
        expect(
          await fixture.call(fixture.service, 'email.messages.get', {
            ...query,
            messageId: message.id,
          }),
        ).toMatchObject({ id: message.id, isRead: !isRead, body: 'A plain body' })
        const latest = (await fixture.call(
          fixture.service,
          'email.messages.list',
          query,
        )) as MailMessagePage
        expect(latest).toMatchObject({ total: 45, unread: 23 })
        expect(latest.items.find((item) => item.id === message.id)?.isRead).toBe(!isRead)
        fixture.advance(1)
        await fixture.service.tick()
        expect((await fixture.get()).reception).toMatchObject({
          lastErrorCode: null,
          lastCheckedAt: '2026-11-12T01:01:00.000Z',
          inbox: reception.inbox,
          junkemail: reception.junkemail,
        })
        expect(fixture.falseResults).toEqual(['STORE'])
        expect(fixture.fetchImpl).not.toHaveBeenCalled()
      } finally {
        await fixture.service.stop()
      }
    },
  )
})

describe('OAuth IMAP mailbox', () => {
  it.each(['unread', 'read'] as const)(
    'filters %s UIDs and returns whole-folder counts',
    async (readState) => {
      const { mailbox, client } = create()
      const page = await mailbox.list(session, { folder: 'inbox', readState }, signal())
      expect(page.total).toBe(45)
      expect(page.unread).toBe(23)
      expect(page.items).toHaveLength(20)
      expect(page.items.every((item) => item.isRead === (readState === 'read'))).toBe(
        true,
      )
      expect(client.search).toHaveBeenCalledWith(
        { uid: '1:45', seen: readState === 'read' },
        { uid: true },
      )
      await expect(
        mailbox.list(
          session,
          {
            folder: 'inbox',
            readState: 'all',
            cursor: page.nextCursor!,
          },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    },
  )

  it('keeps filtered items in scope when flags change between UID search and fetch', async () => {
    const { mailbox, client } = create()
    const search = client.search.getMockImplementation()!
    client.search.mockImplementationOnce(async (query, options) => {
      const found = await search(query, options)
      client.readFlags.set(45, true)
      return found
    })
    const page = await mailbox.list(
      session,
      { folder: 'inbox', readState: 'unread' },
      signal(),
    )
    expect(page.items.every((item) => !item.isRead)).toBe(true)
    expect(page.items.some((item) => item.id.endsWith(':45'))).toBe(false)
    expect(page.nextCursor).not.toBeNull()
  })

  it.each([true, false])(
    'confirms IMAP isRead=%s using UID flags readback',
    async (isRead) => {
      const { mailbox, client } = create()
      const page = await mailbox.list(session, { folder: 'inbox' }, signal())
      const id = page.items[0]!.id
      await mailbox.setRead(session, { folder: 'inbox', messageId: id, isRead }, signal())
      expect(client.mailboxOpen).toHaveBeenLastCalledWith('INBOX', { readOnly: false })
      expect(
        isRead ? client.messageFlagsAdd : client.messageFlagsRemove,
      ).toHaveBeenCalledWith(45, ['\\Seen'], { uid: true })
      expect(client.fetchOne).toHaveBeenLastCalledWith(
        45,
        { uid: true, flags: true },
        { uid: true },
      )
      const latest = await mailbox.list(session, { folder: 'inbox' }, signal())
      expect(latest.items[0]?.isRead).toBe(isRead)
      expect(latest.unread).toBe(isRead ? 22 : 23)
    },
  )

  it('refuses to confirm an IMAP flag update if readback still has the old flag', async () => {
    const { mailbox, client } = create()
    const page = await mailbox.list(session, { folder: 'inbox' }, signal())
    client.messageFlagsAdd.mockImplementationOnce(async () => true)
    await expect(
      mailbox.setRead(
        session,
        {
          folder: 'inbox',
          messageId: page.items[0]!.id,
          isRead: true,
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('checks UIDVALIDITY before a write and never changes a recycled UID', async () => {
    const { mailbox, client } = create()
    const page = await mailbox.list(session, { folder: 'inbox' }, signal())
    client.uidValidity = 900n
    await expect(
      mailbox.setRead(
        session,
        {
          folder: 'inbox',
          messageId: page.items[0]!.id,
          isRead: true,
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(client.messageFlagsAdd).not.toHaveBeenCalled()
  })
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

  it('prefers the MIME text alternative while returning sanitized HTML without attachments', async () => {
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
    expect(detail.html).toBe('<p>Ignore this HTML</p>')
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
