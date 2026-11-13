import { z } from 'zod'

export const ACCOUNT_OBSERVATION_RECORD_METHOD = 'vinted.accounts.observations.record'
export const ACCOUNT_AGENT_SNAPSHOT_METHOD = 'vinted.accounts.agent.snapshot'
export const ACCOUNT_AGENT_METHODS = [
  ACCOUNT_OBSERVATION_RECORD_METHOD,
  ACCOUNT_AGENT_SNAPSHOT_METHOD,
] as const

const timestamp = z.iso.datetime({ offset: true }).max(40)
const status = z.enum(['active', 'pending', 'limited', 'blocked'])
const source = z.enum(['official', 'page', 'model'])
const platformUserId = z.string().regex(/^[1-9]\d{0,31}$/)
// Labels and summaries exclude six-byte control/surrogate escapes in account pages.
const text = z.string().regex(/^[^\p{Cc}\p{Cs}]*$/u)
const tags = z.array(text.min(1).max(24)).max(8)
const summary = text.max(160)
const rating = z.number().min(0).max(5)
// Decimal text preserves precision; no exponent, rounding or implicit zero.
const amount = z
  .string()
  .max(18)
  .regex(/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/)

export const AccountObservationBalanceInputSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  available: amount.nullable(),
  pending: amount.nullable(),
})

export const AccountObservationInputSchema = z.strictObject({
  operationId: z.uuid(),
  accountId: z.uuid(),
  windowId: z.uuid(),
  observedAt: timestamp,
  source,
  platformUserId: platformUserId.optional(),
  status: status.optional(),
  tags: tags.optional(),
  summary: summary.optional(),
  rating: rating.optional(),
  balance: AccountObservationBalanceInputSchema.optional(),
})

const evidence = z.strictObject({ source, observedAt: timestamp })

/** Each retained amount keeps its own evidence when another read is unknown. */
export const AccountObservedBalanceSchema = AccountObservationBalanceInputSchema.extend({
  availableEvidence: evidence.nullable(),
  pendingEvidence: evidence.nullable(),
})

export const AccountLastObservationSchema = AccountObservationInputSchema.omit({
  platformUserId: true,
  tags: true,
  summary: true,
  rating: true,
})

export const AccountObservationStateSchema = z.strictObject({
  platformUserId: platformUserId.optional(),
  tags: tags.optional(),
  summary: summary.optional(),
  rating: rating.optional(),
  balance: AccountObservedBalanceSchema.optional(),
  statusEvidence: z
    .strictObject({
      status,
      source: z.enum(['official', 'page']),
      observedAt: timestamp,
    })
    .optional(),
  lastObservation: AccountLastObservationSchema,
})

export const AccountObservationResultSchema = z.strictObject({
  operationId: z.uuid(),
  accountId: z.uuid(),
  applied: z.boolean(),
  storageDurable: z.boolean(),
})

export const AccountAgentSnapshotInputSchema = z.strictObject({ windowId: z.uuid() })

/** Explicit projection: this contract never includes credential or mailbox fields. */
export const AccountAgentSnapshotResultSchema = z.strictObject({
  account: z.strictObject({
    accountId: z.uuid(),
    account: z.string().min(1).max(190),
    status,
    homepageUrl: z.string().max(2048),
    platformUserId: platformUserId.nullable(),
    observation: AccountObservationStateSchema.nullable(),
  }),
  windowId: z.uuid(),
})

export type AccountObservationInput = z.infer<typeof AccountObservationInputSchema>
export type AccountObservationResult = z.infer<typeof AccountObservationResultSchema>
export type AccountObservationState = z.infer<typeof AccountObservationStateSchema>
export type AccountObservedBalance = z.infer<typeof AccountObservedBalanceSchema>
export type AccountAgentSnapshotInput = z.infer<typeof AccountAgentSnapshotInputSchema>
export type AccountAgentSnapshotResult = z.infer<typeof AccountAgentSnapshotResultSchema>
