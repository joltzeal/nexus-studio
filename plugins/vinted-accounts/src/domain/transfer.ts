import { z } from 'zod'

import { invalidRequest } from './errors.js'
import { AccountSaveInputSchema } from './schemas.js'

const id = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => value.trim().length > 0)
const timestamp = z.string().min(1).max(64)
const receipt = z.uuid()
const MAX_ITEMS = 2000

export const TransferExportInputSchema = z.strictObject({
  windowIds: z.array(id).max(MAX_ITEMS),
  endpointIds: z.array(z.number().int().positive()).max(MAX_ITEMS),
})

const account = AccountSaveInputSchema.omit({ id: true }).extend({
  id,
  createdAt: timestamp,
  updatedAt: timestamp,
})

const binding = z.strictObject({ windowId: id, accountId: id, boundAt: timestamp })

export const AccountTransferDataSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    accounts: z.array(account).max(MAX_ITEMS),
    bindings: z.array(binding).max(MAX_ITEMS),
  })
  .refine((data) => {
    const accounts = new Set(data.accounts.map((entry) => entry.id))
    const windows = new Set(data.bindings.map((entry) => entry.windowId))
    const referenced = new Set(data.bindings.map((entry) => entry.accountId))
    return (
      accounts.size === data.accounts.length &&
      windows.size === data.bindings.length &&
      referenced.size === accounts.size &&
      [...referenced].every((accountId) => accounts.has(accountId))
    )
  })

export const TransferImportInputSchema = z.strictObject({
  data: z.unknown(),
  windowIdMap: z.record(id, id).refine((value) => Object.keys(value).length <= MAX_ITEMS),
  transactionId: receipt.optional(),
})

export const TransferReceiptInputSchema = z.strictObject({ receipt })

export const AccountTransferReceiptSchema = z.strictObject({
  receipt,
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  accountIds: z.array(id).max(MAX_ITEMS),
  bindings: z
    .array(
      z.strictObject({
        imported: binding,
        previous: binding.nullable(),
      }),
    )
    .max(MAX_ITEMS),
})

export type AccountTransferData = z.infer<typeof AccountTransferDataSchema>
export type AccountTransferReceipt = z.infer<typeof AccountTransferReceiptSchema>
export type AccountTransferExportInput = z.input<typeof TransferExportInputSchema>
export type AccountTransferImportInput = z.input<typeof TransferImportInputSchema>
export type AccountTransferReceiptInput = z.input<typeof TransferReceiptInputSchema>
export interface AccountTransferImportResult {
  receipt: string
}

/** Transfer errors never include keys or values from credential-bearing data. */
export function parseTransfer<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw invalidRequest('账号迁移数据或参数无效')
  return result.data
}
