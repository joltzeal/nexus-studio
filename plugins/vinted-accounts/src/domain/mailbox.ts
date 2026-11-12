import { z } from 'zod'

const id = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) =>
      !/\s/.test(value) &&
      [...value].every((character) => {
        const code = character.charCodeAt(0)
        return code >= 32 && code !== 127
      }),
  )

export const AccountMailboxInputSchema = z.strictObject({
  pluginId: z.literal('studio.email'),
  mailboxId: id,
  email: z.email().max(254),
})

export const AssignedAccountMailboxSchema = AccountMailboxInputSchema.extend({
  linkedAt: z.iso.datetime({ offset: true }).max(64),
})

export const AccountMailboxTargetsInputSchema = z.strictObject({
  query: z.string().trim().max(200).optional(),
  page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
})

export const AccountMailboxSetInputSchema = z.strictObject({
  accountId: id,
  mailbox: AccountMailboxInputSchema.nullable(),
  expectedMailboxId: id.nullable(),
})

export type AccountMailboxInput = z.infer<typeof AccountMailboxInputSchema>
export type AssignedAccountMailbox = z.infer<typeof AssignedAccountMailboxSchema>
