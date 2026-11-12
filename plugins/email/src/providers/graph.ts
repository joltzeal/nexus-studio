import { z } from 'zod'
import { invalidRequest, protocolError } from '../domain/errors.js'
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
import { MicrosoftHttp } from './http.js'
import {
  accountKey,
  capText,
  checkFolder,
  checkSession,
  OpaqueCursor,
  readState,
} from './support.js'

const ORIGIN = 'https://graph.microsoft.com'
const properties = [
  'id',
  'subject',
  'from',
  'receivedDateTime',
  'isRead',
  'hasAttachments',
  'bodyPreview',
]
const idSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_+=/-]+$/u)
const addressSchema = z.object({
  emailAddress: z.object({
    name: z.string().nullable().optional(),
    address: z.string(),
  }),
})
const messageSchema = z.object({
  id: idSchema,
  subject: z.string().nullable(),
  from: addressSchema.nullable(),
  receivedDateTime: z.iso.datetime({ offset: true }).nullable(),
  isRead: z.boolean(),
  hasAttachments: z.boolean(),
  bodyPreview: z.string().nullable(),
})
const pageSchema = z.object({
  value: z.array(messageSchema).max(20),
  '@odata.nextLink': z.string().min(1).max(8192).optional(),
})
const detailSchema = messageSchema.extend({
  toRecipients: z.array(addressSchema).max(100),
  body: z.object({
    contentType: z.enum(['text', 'html']),
    content: z.string(),
  }),
})
const cursorSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('graph'),
  account: z.string(),
  folder: z.enum(['inbox', 'junkemail']),
  readState: z.enum(['all', 'unread', 'read']),
  url: z.string().min(1).max(8192),
})
type GraphMessage = z.infer<typeof messageSchema>
const countsSchema = z
  .object({
    totalItemCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    unreadItemCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((value) => value.unreadItemCount <= value.totalItemCount)

function folderPath(folder: MailFolder): string {
  return `/v1.0/me/mailFolders/${folder}/messages`
}

function graphAddress(value: z.infer<typeof addressSchema> | null): MailAddress {
  return {
    name: capText(value?.emailAddress.name ?? '', 256).text,
    address: capText(value?.emailAddress.address ?? '', 320).text,
  }
}

function summary(value: GraphMessage): MailMessage {
  return {
    id: value.id,
    subject: capText(value.subject ?? '', 1024).text,
    from: graphAddress(value.from),
    receivedAt: value.receivedDateTime
      ? new Date(value.receivedDateTime).toISOString()
      : null,
    isRead: value.isRead,
    hasAttachments: value.hasAttachments,
    preview: capText(value.bodyPreview ?? '', 512).text,
  }
}

function continuationUrl(link: string, folder: MailFolder): string {
  try {
    const url = new URL(link)
    const path = decodeURIComponent(url.pathname).toLowerCase()
    const allowed = [
      folderPath(folder).toLowerCase(),
      `/v1.0/me/mailfolders('${folder}')/messages`,
    ]
    if (
      url.origin !== ORIGIN ||
      !allowed.includes(path) ||
      url.username ||
      url.password ||
      url.hash ||
      !url.search
    )
      throw protocolError('Microsoft pagination response is invalid')
    return url.href
  } catch {
    throw protocolError('Microsoft pagination response is invalid')
  }
}

export class MicrosoftGraph implements MailboxClient {
  constructor(
    private readonly http: MicrosoftHttp,
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
    const path = folderPath(input.folder)
    let requestUrl: string
    if (input.cursor !== undefined) {
      const parsed = cursorSchema.safeParse(this.cursors.decode(input.cursor))
      if (
        !parsed.success ||
        parsed.data.folder !== input.folder ||
        parsed.data.readState !== filter ||
        parsed.data.account !== accountKey(session)
      )
        throw invalidRequest('Email cursor does not match this mailbox')
      requestUrl = continuationUrl(parsed.data.url, input.folder)
    } else {
      requestUrl = `${ORIGIN}${path}?${new URLSearchParams({
        $top: '20',
        $orderby: 'receivedDateTime desc',
        $select: properties.join(','),
        ...(filter === 'all'
          ? {}
          : {
              $filter: `receivedDateTime ge 0001-01-01T00:00:00Z and isRead eq ${filter === 'read'}`,
            }),
      })}`
    }
    const body = await this.http.json(
      requestUrl,
      { headers: this.headers(session) },
      signal,
      'graph',
    )
    const page = pageSchema.safeParse(body)
    if (!page.success) throw protocolError('Microsoft message list is invalid')
    const next = page.data['@odata.nextLink']
    const counts = countsSchema.safeParse(
      await this.http.json(
        `${ORIGIN}/v1.0/me/mailFolders/${input.folder}?$select=totalItemCount,unreadItemCount`,
        { headers: this.headers(session) },
        signal,
        'graph',
      ),
    )
    if (!counts.success) throw protocolError('Microsoft folder counts are invalid')
    return {
      items: page.data.value.map(summary),
      total: counts.data.totalItemCount,
      unread: counts.data.unreadItemCount,
      nextCursor:
        next === undefined
          ? null
          : this.cursors.encode({
              v: 1,
              kind: 'graph',
              account: accountKey(session),
              folder: input.folder,
              readState: filter,
              url: continuationUrl(next, input.folder),
            }),
    }
  }

  async get(
    session: MailSession,
    input: MailGetInput,
    signal: AbortSignal,
  ): Promise<MailMessageDetail> {
    checkSession(session)
    checkFolder(input.folder)
    if (!idSchema.safeParse(input.messageId).success) {
      throw invalidRequest('Microsoft message ID is invalid')
    }
    const url = new URL(
      `${ORIGIN}${folderPath(input.folder)}/${encodeURIComponent(input.messageId)}`,
    )
    url.searchParams.set('$select', [...properties, 'toRecipients', 'body'].join(','))
    const body = await this.http.json(
      url.href,
      {
        headers: this.headers(session),
      },
      signal,
      'graph',
    )
    const detail = detailSchema.safeParse(body)
    if (!detail.success || detail.data.id !== input.messageId) {
      throw protocolError('Microsoft message detail is invalid')
    }
    const content = mailContent(
      detail.data.body.contentType === 'text' ? detail.data.body.content : undefined,
      detail.data.body.contentType === 'html' ? detail.data.body.content : undefined,
    )
    return {
      ...summary(detail.data),
      to: detail.data.toRecipients.map(graphAddress),
      ...content,
    }
  }

  async setRead(
    session: MailSession,
    input: MailReadInput,
    signal: AbortSignal,
  ): Promise<void> {
    checkSession(session)
    checkFolder(input.folder)
    if (
      !idSchema.safeParse(input.messageId).success ||
      typeof input.isRead !== 'boolean'
    ) {
      throw invalidRequest('Microsoft read-state request is invalid')
    }
    const url = `${ORIGIN}${folderPath(input.folder)}/${encodeURIComponent(input.messageId)}`
    let response = await this.http.json(
      url,
      {
        method: 'PATCH',
        headers: { ...this.headers(session), 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRead: input.isRead }),
      },
      signal,
      'graph',
      true,
    )
    if (response === null)
      response = await this.http.json(
        `${url}?$select=id,isRead`,
        { headers: this.headers(session) },
        signal,
        'graph',
      )
    const confirmed = z.object({ id: idSchema, isRead: z.boolean() }).safeParse(response)
    if (
      !confirmed.success ||
      confirmed.data.id !== input.messageId ||
      confirmed.data.isRead !== input.isRead
    ) {
      throw protocolError('Microsoft read-state update could not be confirmed')
    }
  }

  private headers(session: MailSession): Record<string, string> {
    return {
      Authorization: `Bearer ${session.accessToken}`,
      Accept: 'application/json',
    }
  }
}
