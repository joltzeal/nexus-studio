import { z } from 'zod'
import { invalidRequest } from './errors.js'
import {
  ClientIdSchema,
  CredentialSchema,
  EmailSchema,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ERRORS,
  MAX_IMPORT_ROWS,
} from './schemas.js'

const rowSchema = z.strictObject({
  row: z.number().int().positive(),
  email: EmailSchema,
  password: z.string().max(512),
  clientId: ClientIdSchema,
  refreshToken: CredentialSchema,
})
export type ImportRow = z.infer<typeof rowSchema>

export function parseMailboxImport(text: string): {
  total: number
  rows: ImportRow[]
  errors: { row: number; message: string }[]
} {
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES)
    throw invalidRequest('导入文本不能超过 512 KiB')
  const nonempty = text
    .replace(/^\uFEFF/u, '')
    .split(/\r?\n/u)
    .map((line, index) => ({ line, row: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
  if (nonempty.length === 0 || nonempty.length > MAX_IMPORT_ROWS)
    throw invalidRequest('每次导入需要 1–500 行邮箱资料')
  const rows: ImportRow[] = []
  const errors: { row: number; message: string }[] = []
  for (const { line, row } of nonempty) {
    const fields = line.split('----')
    const parsed =
      fields.length === 4
        ? rowSchema.safeParse({
            row,
            email: fields[0]?.trim(),
            password: fields[1],
            clientId: fields[2]?.trim(),
            refreshToken: fields[3]?.trim(),
          })
        : null
    if (parsed?.success) rows.push(parsed.data)
    else if (errors.length < MAX_IMPORT_ERRORS)
      errors.push({
        row,
        message: '需要有效的邮箱、密码、client_id 和 refresh_token，以 ---- 分隔',
      })
  }
  return { total: nonempty.length, rows, errors }
}
