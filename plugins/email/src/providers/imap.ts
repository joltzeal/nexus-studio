import { createHash } from 'node:crypto'
import type {
  FetchMessageObject,
  FetchQueryObject,
  ImapFlowOptions,
  ImapResponse,
  ListResponse,
  MailboxObject,
  MessageAddressObject,
  MessageStructureObject,
  StatusObject,
} from 'imapflow'
import { simpleParser } from 'mailparser'
import { z } from 'zod'
import {
  cancelled,
  invalidRequest,
  isPluginFailure,
  PluginFailure,
  protocolError,
  unavailable,
} from '../domain/errors.js'
import type {
  MailAddress,
  MailboxClient,
  MailFolder,
  MailGetInput,
  MailListInput,
  MailMessage,
  MailMessageDetail,
  MailMessagePage,
  MailSession,
  MailReadInput,
} from '../domain/types.js'
import { mailContent } from './content.js'
import {
  accountKey,
  bounded,
  capText,
  checkFolder,
  checkSession,
  hasControlCharacters,
  MAX_SOURCE_BYTES,
  OpaqueCursor,
  TIMEOUT_MS,
  readState,
} from './support.js'

export interface ImapClient {
  connect(): Promise<void>
  close(): void
  on(event: 'error', listener: (error: unknown) => void): unknown
  list(): Promise<ListResponse[]>
  mailboxOpen(path: string, options: { readOnly: boolean }): Promise<MailboxObject>
  status(
    path: string,
    query: { messages: true; unseen: true },
  ): Promise<StatusObject | false>
  messageFlagsAdd(uid: number, flags: string[], options: { uid: true }): Promise<boolean>
  messageFlagsRemove(
    uid: number,
    flags: string[],
    options: { uid: true },
  ): Promise<boolean>
  search(
    query: { uid: string; seen?: boolean },
    options: { uid: true },
  ): Promise<number[] | false | undefined>
  fetchAll(
    range: string,
    query: FetchQueryObject,
    options: { uid: true },
  ): Promise<FetchMessageObject[]>
  fetchOne(
    uid: number,
    query: FetchQueryObject,
    options: { uid: true },
  ): Promise<FetchMessageObject | false>
}

export type ImapClientFactory = (options: ImapFlowOptions) => ImapClient

const MAX_UID = 0xffffffff
const uidSchema = z.number().int().min(1).max(MAX_UID)
const cursorSchema = z
  .strictObject({
    v: z.literal(1),
    kind: z.literal('imap'),
    account: z.string(),
    folder: z.enum(['inbox', 'junkemail']),
    readState: z.enum(['all', 'unread', 'read']),
    path: z.string().min(1).max(1024),
    validity: z.string().regex(/^[1-9]\d{0,9}$/u),
    snapshot: z.number().int().min(0).max(MAX_UID),
    before: z
      .number()
      .int()
      .min(1)
      .max(MAX_UID + 1),
  })
  .refine((value) => value.before <= value.snapshot + 1)
const metadataQuery = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  bodyStructure: true,
}
type Context = {
  client: ImapClient
  mailbox: MailboxObject
  path: string
  signal: AbortSignal
}

export function imapProxy(value: string | undefined): string | undefined {
  if (value === undefined) return
  const failure = () =>
    new PluginFailure('NOT_CONFIGURED', 'Email IMAP proxy configuration is invalid')
  if (!value || value.length > 4096 || /\s/u.test(value) || hasControlCharacters(value)) {
    throw failure()
  }
  try {
    const url = new URL(value)
    if (
      !['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) ||
      !url.hostname ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search ||
      url.hash ||
      (url.port && Number(url.port) < 1) ||
      hasControlCharacters(
        decodeURIComponent(url.username) + decodeURIComponent(url.password),
      )
    )
      throw failure()
    // ImapFlow's SOCKS5 implementation sends the destination hostname to the proxy.
    if (url.protocol === 'socks5h:') url.protocol = 'socks5:'
    return url.href
  } catch {
    throw failure()
  }
}

function imapFailure(error: unknown): PluginFailure {
  if (isPluginFailure(error)) return error
  if (error && typeof error === 'object') {
    const auth = 'authenticationFailed' in error && error.authenticationFailed === true
    const response = 'serverResponseCode' in error ? error.serverResponseCode : undefined
    const code = 'code' in error ? error.code : undefined
    if (response === 'NOPERM' || response === 'AUTHORIZATIONFAILED') {
      return new PluginFailure(
        'PERMISSION_DENIED',
        'Microsoft mail permission is missing',
      )
    }
    if (auth || response === 'AUTHENTICATIONFAILED' || response === 'NOAUTH') {
      return new PluginFailure('AUTH_FAILED', 'Microsoft authorization must be renewed')
    }
    if (
      ['ETIMEDOUT', 'CONNECT_TIMEOUT', 'SocketTimeout', 'GreetingTimeout'].includes(
        String(code),
      )
    ) {
      return new PluginFailure('TIMEOUT', 'Email IMAP request timed out')
    }
  }
  return unavailable('Email IMAP connection failed')
}

function commandFailure(error: unknown): PluginFailure | undefined {
  if (!error || typeof error !== 'object') return
  const response =
    'response' in error && error.response && typeof error.response === 'object'
      ? (error.response as ImapResponse)
      : undefined
  const first = Array.isArray(response?.attributes) ? response.attributes[0] : undefined
  const parsed =
    first && Array.isArray(first.section) ? first.section[0]?.value : undefined
  const code = 'serverResponseCode' in error ? error.serverResponseCode : parsed
  if (typeof code !== 'string' || code.length > 64) return
  const failure = imapFailure({ serverResponseCode: code.trim().toUpperCase() })
  if (failure.code === 'AUTH_FAILED' || failure.code === 'PERMISSION_DENIED') {
    return failure
  }
}

async function withCommandFailure<T>(
  client: ImapClient,
  command: 'STATUS' | 'UID STORE',
  operation: () => Promise<T>,
): Promise<T> {
  if (!('exec' in client) || typeof client.exec !== 'function') return operation()
  const connection = client as ImapClient & {
    exec(command: string, ...args: unknown[]): Promise<unknown>
  }
  const exec = connection.exec
  let failure: PluginFailure | undefined
  // ImapFlow 2.11 swallows STATUS/STORE rejections. Keep only their safe code,
  // scoped to this call so a nested LIST probe or a later command cannot replace it.
  connection.exec = async (actual, ...args) => {
    try {
      return await exec.call(connection, actual, ...args)
    } catch (error) {
      if (actual === command) failure = commandFailure(error)
      throw error
    }
  }
  try {
    const result = await operation()
    if (result === false && failure) throw failure
    return result
  } catch (error) {
    // STATUS wraps its original NO rejection in NotFound after an empty LIST.
    if (
      command === 'STATUS' &&
      failure &&
      !isPluginFailure(error) &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'NotFound' &&
      'response' in error &&
      error.response &&
      typeof error.response === 'object' &&
      'responseStatus' in error.response &&
      error.response.responseStatus === 'NO' &&
      commandFailure(error.response)?.code === failure.code
    ) {
      throw failure
    }
    throw error
  } finally {
    connection.exec = exec
  }
}

function active(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled()
}

function address(value: MessageAddressObject | undefined): MailAddress {
  if (
    value &&
    ((value.name !== undefined && typeof value.name !== 'string') ||
      (value.address !== undefined && typeof value.address !== 'string'))
  )
    throw protocolError('Email IMAP address is invalid')
  return {
    name: capText(value?.name ?? '', 256).text,
    address: capText(value?.address ?? '', 320).text,
  }
}

function attachments(structure: MessageStructureObject | undefined): boolean {
  if (!structure) throw protocolError('Email IMAP message structure is missing')
  const pending = [structure]
  let seen = 0
  let found = false
  while (pending.length) {
    const node = pending.pop()!
    if (
      ++seen > 1000 ||
      !node ||
      typeof node.type !== 'string' ||
      (node.disposition !== undefined && typeof node.disposition !== 'string') ||
      (node.childNodes !== undefined && !Array.isArray(node.childNodes))
    )
      throw protocolError('Email IMAP message structure is invalid')
    if (
      node.disposition?.toLowerCase() === 'attachment' ||
      node.dispositionParameters?.filename ||
      node.parameters?.name
    )
      found = true
    if (node.childNodes) {
      if (pending.length + node.childNodes.length > 1000) {
        throw protocolError('Email IMAP message structure is too large')
      }
      pending.push(...node.childNodes)
    }
  }
  return found
}

function mailboxIdentity(session: MailSession, path: string): string {
  return createHash('sha256')
    .update(`${accountKey(session)}\0${path}`)
    .digest('hex')
}

function messageId(
  session: MailSession,
  folder: MailFolder,
  mailbox: MailboxObject,
  uid: number,
): string {
  return `imap:${mailboxIdentity(session, mailbox.path)}:${folder}:${mailbox.uidValidity}:${uid}`
}

function summary(
  value: FetchMessageObject,
  session: MailSession,
  folder: MailFolder,
  mailbox: MailboxObject,
): MailMessage {
  if (
    !value ||
    !uidSchema.safeParse(value.uid).success ||
    !value.envelope ||
    typeof value.envelope !== 'object' ||
    !(value.flags instanceof Set) ||
    ![...value.flags].every((flag) => typeof flag === 'string') ||
    (value.envelope.subject !== undefined &&
      typeof value.envelope.subject !== 'string') ||
    (value.envelope.from !== undefined && !Array.isArray(value.envelope.from))
  )
    throw protocolError('Email IMAP message metadata is invalid')
  const received = value.internalDate ?? value.envelope.date
  const date = received === undefined ? null : new Date(received)
  if (date && !Number.isFinite(date.getTime())) {
    throw protocolError('Email IMAP received date is invalid')
  }
  return {
    id: messageId(session, folder, mailbox, value.uid),
    subject: capText(value.envelope.subject ?? '', 1024).text,
    from: address(value.envelope.from?.[0]),
    receivedAt: date?.toISOString() ?? null,
    isRead: value.flags.has('\\Seen'),
    hasAttachments: attachments(value.bodyStructure),
    preview: '',
  }
}

export class MicrosoftImap implements MailboxClient {
  constructor(
    private readonly createClient: ImapClientFactory,
    private readonly proxy: string | undefined,
    private readonly cursors: OpaqueCursor,
  ) {}

  async list(
    session: MailSession,
    input: MailListInput,
    signal: AbortSignal,
  ): Promise<MailMessagePage> {
    checkSession(session)
    checkFolder(input.folder)
    const filter = readState(input.readState)
    const parsed =
      input.cursor === undefined
        ? null
        : cursorSchema.safeParse(this.cursors.decode(input.cursor))
    if (
      parsed &&
      (!parsed.success ||
        parsed.data.account !== accountKey(session) ||
        parsed.data.folder !== input.folder ||
        parsed.data.readState !== filter)
    )
      throw invalidRequest('Email cursor does not match this mailbox')
    const cursor = parsed?.success ? parsed.data : null
    return this.withMailbox(session, input.folder, signal, async (context) => {
      const { client, mailbox, path } = context
      if (
        cursor &&
        (cursor.path !== path ||
          cursor.validity !== mailbox.uidValidity.toString() ||
          cursor.snapshot >= mailbox.uidNext)
      )
        throw invalidRequest('Email mailbox changed; reload the message list')
      const snapshot = cursor?.snapshot ?? mailbox.uidNext - 1
      const upper = Math.min(snapshot, (cursor?.before ?? snapshot + 1) - 1)
      const counts = await withCommandFailure(client, 'STATUS', () =>
        client.status(path, { messages: true, unseen: true }),
      )
      active(context.signal)
      if (
        !counts ||
        !Number.isSafeInteger(counts.messages) ||
        !Number.isSafeInteger(counts.unseen) ||
        counts.messages! < 0 ||
        counts.unseen! < 0 ||
        counts.unseen! > counts.messages!
      ) {
        throw protocolError('Email IMAP folder counts are invalid')
      }
      const totals = { total: counts.messages!, unread: counts.unseen! }
      if (!upper) return { items: [], nextCursor: null, ...totals }
      const found = await client.search(
        {
          uid: `1:${upper}`,
          ...(filter === 'all' ? {} : { seen: filter === 'read' }),
        },
        { uid: true },
      )
      active(context.signal)
      if (
        !Array.isArray(found) ||
        found.some((uid) => !uidSchema.safeParse(uid).success || uid > upper) ||
        new Set(found).size !== found.length
      )
        throw protocolError('Email IMAP UID search response is invalid')
      const selected = found.sort((a, b) => b - a).slice(0, 20)
      if (!selected.length) return { items: [], nextCursor: null, ...totals }
      const messages = await client.fetchAll(selected.join(','), metadataQuery, {
        uid: true,
      })
      active(context.signal)
      if (
        !Array.isArray(messages) ||
        messages.length !== selected.length ||
        new Set(messages.map((message) => message.uid)).size !== messages.length ||
        messages.some((message) => !selected.includes(message.uid))
      )
        throw protocolError('Email IMAP message list response is invalid')
      const byUid = new Map(messages.map((message) => [message.uid, message]))
      return {
        ...totals,
        items: selected
          .map((uid) => summary(byUid.get(uid)!, session, input.folder, mailbox))
          .filter((item) => filter === 'all' || item.isRead === (filter === 'read')),
        nextCursor:
          found.length > selected.length
            ? this.cursors.encode({
                v: 1,
                kind: 'imap',
                account: accountKey(session),
                folder: input.folder,
                readState: filter,
                path,
                validity: mailbox.uidValidity.toString(),
                snapshot,
                before: selected[selected.length - 1],
              })
            : null,
      }
    })
  }

  async get(
    session: MailSession,
    input: MailGetInput,
    signal: AbortSignal,
  ): Promise<MailMessageDetail> {
    checkSession(session)
    checkFolder(input.folder)
    const id =
      typeof input.messageId === 'string'
        ? /^imap:([a-f0-9]{64}):(inbox|junkemail):([1-9]\d{0,9}):([1-9]\d{0,9})$/u.exec(
            input.messageId,
          )
        : null
    if (!id || id[2] !== input.folder || !uidSchema.safeParse(Number(id[4])).success) {
      throw invalidRequest('Email IMAP message ID is invalid')
    }
    const uid = Number(id[4])
    return this.withMailbox(session, input.folder, signal, async (context) => {
      const { client, mailbox } = context
      if (messageId(session, input.folder, mailbox, uid) !== input.messageId) {
        throw invalidRequest('Email mailbox changed; reload the message list')
      }
      const meta = await client.fetchOne(
        uid,
        { ...metadataQuery, size: true },
        { uid: true },
      )
      active(context.signal)
      if (!meta || meta.uid !== uid)
        throw protocolError('Email IMAP message is no longer available')
      const message = summary(meta, session, input.folder, mailbox)
      if (
        typeof meta.size !== 'number' ||
        !Number.isSafeInteger(meta.size) ||
        meta.size < 0 ||
        meta.size > MAX_SOURCE_BYTES
      )
        throw protocolError('Email IMAP message exceeds the source size limit')
      const content = await client.fetchOne(
        uid,
        {
          uid: true,
          source: { start: 0, maxLength: MAX_SOURCE_BYTES },
        },
        { uid: true },
      )
      active(context.signal)
      if (
        !content ||
        content.uid !== uid ||
        !Buffer.isBuffer(content.source) ||
        content.source.length > MAX_SOURCE_BYTES ||
        content.source.length !== meta.size
      )
        throw protocolError('Email IMAP message source is invalid or incomplete')
      let parsed
      try {
        parsed = await simpleParser(content.source, {
          skipHtmlToText: true,
          skipTextToHtml: true,
          skipImageLinks: true,
          keepCidLinks: true,
          ignoreEmbedded: true,
          checksumAlgo: false,
          maxHeadSize: 64 * 1024,
          maxChildNodes: 100,
        })
      } catch {
        throw protocolError('Email MIME message could not be parsed')
      }
      active(context.signal)
      const recipients = (
        Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : []
      ).flatMap((group) => group.value)
      if (recipients.length > 100)
        throw protocolError('Email recipient list is too large')
      const presentation = mailContent(
        parsed.text,
        typeof parsed.html === 'string' ? parsed.html : undefined,
      )
      return {
        ...message,
        subject: capText(parsed.subject ?? message.subject, 1024).text,
        from: parsed.from?.value[0] ? address(parsed.from.value[0]) : message.from,
        to: recipients.map(address),
        hasAttachments: message.hasAttachments || parsed.attachments.length > 0,
        preview: capText(presentation.body, 512).text,
        ...presentation,
      }
    })
  }

  async setRead(
    session: MailSession,
    input: MailReadInput,
    signal: AbortSignal,
  ): Promise<void> {
    checkSession(session)
    checkFolder(input.folder)
    const id =
      typeof input.messageId === 'string'
        ? /^imap:([a-f0-9]{64}):(inbox|junkemail):([1-9]\d{0,9}):([1-9]\d{0,9})$/u.exec(
            input.messageId,
          )
        : null
    if (
      !id ||
      id[2] !== input.folder ||
      !uidSchema.safeParse(Number(id[4])).success ||
      typeof input.isRead !== 'boolean'
    ) {
      throw invalidRequest('Email IMAP read-state request is invalid')
    }
    const uid = Number(id[4])
    await this.withMailbox(
      session,
      input.folder,
      signal,
      async (context) => {
        const { client, mailbox } = context
        if (messageId(session, input.folder, mailbox, uid) !== input.messageId) {
          throw invalidRequest('Email mailbox changed; reload the message list')
        }
        const written = await withCommandFailure(client, 'UID STORE', () =>
          input.isRead
            ? client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
            : client.messageFlagsRemove(uid, ['\\Seen'], { uid: true }),
        )
        active(context.signal)
        if (written !== true)
          throw protocolError('Email IMAP read-state write was not accepted')
        const confirmed = await client.fetchOne(
          uid,
          { uid: true, flags: true },
          { uid: true },
        )
        active(context.signal)
        if (
          !confirmed ||
          confirmed.uid !== uid ||
          !(confirmed.flags instanceof Set) ||
          confirmed.flags.has('\\Seen') !== input.isRead
        ) {
          throw protocolError('Email IMAP read-state update could not be confirmed')
        }
      },
      false,
    )
  }

  private async withMailbox<T>(
    session: MailSession,
    folder: MailFolder,
    signal: AbortSignal,
    operation: (context: Context) => Promise<T>,
    readOnly = true,
  ): Promise<T> {
    let client: ImapClient | undefined
    let closed = false
    const close = () => {
      if (client && !closed) {
        closed = true
        try {
          client.close()
        } catch {
          /* Closing must not leak a transport error. */
        }
      }
    }
    try {
      return await bounded(
        signal,
        async (requestSignal) => {
          client = this.createClient({
            host: 'outlook.office365.com',
            port: 993,
            secure: true,
            auth: { user: session.email, accessToken: session.accessToken },
            logger: false,
            logRaw: false,
            emitLogs: false,
            disableAutoIdle: true,
            connectionTimeout: TIMEOUT_MS,
            greetingTimeout: TIMEOUT_MS,
            socketTimeout: TIMEOUT_MS,
            maxLiteralSize: MAX_SOURCE_BYTES,
            maxLineLength: MAX_SOURCE_BYTES,
            maxResponseSize: MAX_SOURCE_BYTES + 64 * 1024,
            maxResponseTokens: 100_000,
            ...(this.proxy === undefined ? {} : { proxy: this.proxy }),
          })
          const connection = client
          const failed = new Promise<never>((_resolve, reject) => {
            connection.on('error', (error) => reject(imapFailure(error)))
          })
          const work = async () => {
            await connection.connect()
            active(requestSignal)
            let path = 'INBOX'
            if (folder === 'junkemail') {
              const folders = await connection.list()
              active(requestSignal)
              if (!Array.isArray(folders))
                throw protocolError('Email IMAP folder list is invalid')
              const junk = folders.filter(
                (entry) =>
                  entry.flags?.has('\\Junk') ||
                  (entry.specialUse === '\\Junk' &&
                    entry.specialUseSource === 'extension'),
              )
              if (!junk.length) throw unavailable('Email IMAP junk folder is unavailable')
              if (junk.length !== 1 || !junk[0]?.path || junk[0].path.length > 1024) {
                throw protocolError('Email IMAP junk folder is ambiguous or invalid')
              }
              path = junk[0].path
            }
            const mailbox = await connection.mailboxOpen(path, { readOnly })
            active(requestSignal)
            if (!readOnly && mailbox.readOnly === true) {
              throw new PluginFailure(
                'PERMISSION_DENIED',
                'Email IMAP mailbox is read-only',
              )
            }
            if (
              !mailbox ||
              mailbox.path !== path ||
              mailbox.readOnly !== readOnly ||
              typeof mailbox.uidValidity !== 'bigint' ||
              mailbox.uidValidity < 1n ||
              mailbox.uidValidity > BigInt(MAX_UID) ||
              !Number.isSafeInteger(mailbox.uidNext) ||
              mailbox.uidNext < 1 ||
              mailbox.uidNext > MAX_UID + 1 ||
              !Number.isSafeInteger(mailbox.exists) ||
              mailbox.exists < 0
            )
              throw protocolError('Email IMAP mailbox state is invalid')
            return operation({ client: connection, mailbox, path, signal: requestSignal })
          }
          try {
            return await Promise.race([work(), failed])
          } catch (error) {
            throw imapFailure(error)
          }
        },
        close,
      )
    } finally {
      close()
    }
  }
}
