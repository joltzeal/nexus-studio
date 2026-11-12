import { z } from 'zod'
import { invalidRequest, PLUGIN_ERROR_CODES } from './errors.js'

export const MAX_MAILBOXES = 2000
export const MAX_IMPORT_BYTES = 512 * 1024
export const MAX_IMPORT_ROWS = 500
export const MAX_IMPORT_ERRORS = 50
export const EmailSchema = z.email().trim().max(254)
export const ClientIdSchema = z.uuid()
export const CredentialSchema = z
  .string()
  .min(1)
  .max(16 * 1024)
  .refine(
    (value) =>
      !/\s/u.test(value) &&
      Array.from(value).every((character) => {
        const code = character.charCodeAt(0)
        return code > 31 && code !== 127
      }),
  )
export const TransportSchema = z.enum(['graph', 'imap'])
export const StatusSchema = z.enum([
  'pending',
  'active',
  'reauth-required',
  'error',
  'paused',
])
export const SettingsSchema = z.strictObject({
  autoRefresh: z.boolean(),
  intervalMinutes: z.number().int().min(5).max(1440),
  autoReceive: z.boolean(),
  receiveIntervalMinutes: z.number().int().min(1).max(60),
})
const timestamp = z.iso.datetime()
const nullableTimestamp = timestamp.nullable()
export const FolderCountsSchema = z
  .strictObject({
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    unread: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((counts) => counts.unread <= counts.total)
export const ReceptionSchema = z.strictObject({
  lastCheckedAt: nullableTimestamp,
  nextCheckAt: nullableTimestamp,
  latestReceivedAt: nullableTimestamp,
  lastError: z.string().max(500).nullable(),
  lastErrorCode: z.enum(PLUGIN_ERROR_CODES).nullable(),
  inbox: FolderCountsSchema.nullable(),
  junkemail: FolderCountsSchema.nullable(),
})

export const MailboxRecordSchema = z.strictObject({
  id: z.uuid(),
  provider: z.literal('microsoft'),
  transport: TransportSchema,
  email: EmailSchema,
  password: z.string().max(512),
  clientId: ClientIdSchema,
  refreshToken: CredentialSchema,
  accessToken: CredentialSchema.nullable(),
  accessExpiresAt: nullableTimestamp,
  credentialRevision: z.uuid(),
  note: z.string().max(1000),
  enabled: z.boolean(),
  status: StatusSchema,
  lastAttemptAt: nullableTimestamp,
  lastRefreshedAt: nullableTimestamp,
  lastRotatedAt: nullableTimestamp,
  nextRefreshAt: nullableTimestamp,
  refreshRequested: z.boolean(),
  consecutiveFailures: z.number().int().min(0).max(32),
  lastError: z.string().max(500).nullable(),
  lastErrorCode: z.enum(PLUGIN_ERROR_CODES).nullable(),
  reception: ReceptionSchema,
  receiveRequested: z.boolean(),
  receiveFailures: z.number().int().min(0).max(32),
  createdAt: timestamp,
  updatedAt: timestamp,
})

export const StoreDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    settings: SettingsSchema,
    accounts: z.array(MailboxRecordSchema).max(MAX_MAILBOXES),
  })
  .refine(
    ({ accounts }) =>
      new Set(accounts.map((account) => account.id)).size === accounts.length &&
      new Set(accounts.map((account) => account.email.toLowerCase())).size ===
        accounts.length,
  )

export const SaveInputSchema = z.strictObject({
  id: z.uuid().optional(),
  provider: z.literal('microsoft'),
  transport: TransportSchema,
  email: EmailSchema,
  clientId: ClientIdSchema,
  password: z.string().max(512).optional(),
  refreshToken: CredentialSchema.optional(),
  note: z.string().trim().max(1000),
  enabled: z.boolean(),
})
export type SaveInput = z.infer<typeof SaveInputSchema>
export const ListInputSchema = z.strictObject({
  query: z.string().trim().max(254).default(''),
  status: StatusSchema.optional(),
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
})
export const IdInputSchema = z.strictObject({ id: z.uuid() })
export const RefreshInputSchema = z.strictObject({
  ids: z.array(z.uuid()).min(1).max(100),
})
export const ReceiveInputSchema = z.strictObject({
  ids: z
    .array(z.uuid())
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length),
})
export const TargetsInputSchema = ListInputSchema.omit({ status: true })
export const ImportInputSchema = z.strictObject({
  text: z.string().max(MAX_IMPORT_BYTES),
  transport: TransportSchema,
})
export const MessageListInputSchema = z.strictObject({
  accountId: z.uuid(),
  expectedEmail: EmailSchema.optional(),
  folder: z.enum(['inbox', 'junkemail']),
  readState: z.enum(['all', 'unread', 'read']).optional(),
  cursor: z
    .string()
    .min(1)
    .max(16 * 1024)
    .optional(),
})
export const MessageGetInputSchema = MessageListInputSchema.omit({
  cursor: true,
  readState: true,
}).extend({ messageId: z.string().min(1).max(2048) })
export const MessageReadInputSchema = MessageGetInputSchema.omit({
  messageId: true,
}).extend({
  messageIds: z
    .array(z.string().min(1).max(2048))
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length),
  isRead: z.boolean(),
})
export const EmptyInputSchema = z.strictObject({})

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw invalidRequest('邮箱参数格式无效，请检查输入后重试')
  return parsed.data
}
