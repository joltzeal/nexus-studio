import { z } from 'zod'

import { invalidRequest } from './errors.js'

const idSchema = z.string().trim().min(1).max(64)
const linkSchema = z.string().trim().max(2048)

/** A single line-delimited RPC message must stay under the host's 1 MiB cap. */
export const MAX_IMPORT_TEXT_CHARS = 512 * 1024
export const MAX_IMPORT_BASE64_CHARS = 512 * 1024

export const AccountSaveInputSchema = z.strictObject({
  /** Present when editing an existing account. */
  id: idSchema.optional(),
  loginMethod: z.enum(['email', 'google', 'apple', 'facebook']),
  account: z.string().trim().min(1).max(190),
  // Never trimmed: a trailing space can be part of a real password.
  password: z.string().min(1).max(190),
  phone: z.string().trim().max(40),
  emailOtpUrl: linkSchema,
  smsOtpUrl: linkSchema,
  note: z.string().trim().max(200),
  status: z.enum(['active', 'pending', 'limited', 'blocked']),
  homepageUrl: linkSchema,
})

export const AccountIdInputSchema = z.strictObject({
  accountId: idSchema,
})

/**
 * Which of the account's two inbox links to read. The channel is explicit
 * because an account may carry both, and guessing would fetch the wrong one.
 */
export const OtpInputSchema = z.strictObject({
  accountId: idSchema,
  channel: z.enum(['email', 'sms']),
})

export const BindInputSchema = z.strictObject({
  accountId: idSchema,
  windowId: idSchema,
  /** Second call from the page once the duplicate warning was accepted. */
  confirmDuplicates: z.boolean().optional(),
})

export const WindowIdInputSchema = z.strictObject({
  windowId: idSchema,
})

export const ImportInputSchema = z.strictObject({
  filename: z.string().trim().min(1).max(200),
  /** CSV arrives as text; a binary workbook arrives base64-encoded. */
  text: z.string().max(MAX_IMPORT_TEXT_CHARS).optional(),
  base64: z.string().max(MAX_IMPORT_BASE64_CHARS).optional(),
})

export const TemplateInputSchema = z.strictObject({
  format: z.enum(['csv', 'xlsx']),
})

export function parseOrThrow<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload ?? {})
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  if (issue === undefined) throw invalidRequest('请求参数无效')
  const path = issue.path.join('.')
  throw invalidRequest(path === '' ? issue.message : `${path}：${issue.message}`)
}
