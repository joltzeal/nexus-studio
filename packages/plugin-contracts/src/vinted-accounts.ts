import { z } from 'zod'

export const ACCOUNT_OBSERVATION_RESERVE_METHOD = 'vinted.accounts.observations.reserve'
export const ACCOUNT_OBSERVATION_RECORD_METHOD = 'vinted.accounts.observations.record'
export const ACCOUNT_AGENT_SNAPSHOT_METHOD = 'vinted.accounts.agent.snapshot'
export const ACCOUNT_AGENT_METHODS = [
  ACCOUNT_OBSERVATION_RESERVE_METHOD,
  ACCOUNT_OBSERVATION_RECORD_METHOD,
  ACCOUNT_AGENT_SNAPSHOT_METHOD,
] as const

const timestamp = z.iso.datetime({ offset: true }).max(40)
const status = z.enum(['active', 'pending', 'limited', 'blocked'])
const source = z.enum(['official', 'page', 'model'])
const platformUserId = z.string().regex(/^[1-9]\d{0,31}$/)
const text = z.string().regex(/^[^\p{Cc}\p{Cs}]*$/u)
const tags = z.array(text.min(1).max(24)).max(8)
const summary = text.max(160)
const rating = z.number().min(0).max(5)
const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const amount = z
  .string()
  .max(18)
  .regex(/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/)

export const AccountObservationDomainSchema = z.enum([
  'identity',
  'session',
  'wallet.available',
  'wallet.pending',
  'bankAccounts',
  'analysis',
])
const domains = z
  .array(AccountObservationDomainSchema)
  .min(1)
  .max(6)
  .refine((values) => new Set(values).size === values.length)
const bindingContext = {
  operationId: z.uuid(),
  accountId: z.uuid(),
  windowId: z.uuid(),
  bindingRevision: z.uuid(),
}

export const AccountObservationReserveInputSchema = z.strictObject({
  ...bindingContext,
  domains,
})
export const AccountObservationReserveResultSchema = z.strictObject({
  ...bindingContext,
  sequence,
  storageDurable: z.boolean(),
})
export const AccountMoneyInputSchema = z.strictObject({
  amount,
  currency: z.string().regex(/^[A-Z]{3}$/),
})
export const AccountObservedMoneySchema = AccountMoneyInputSchema.extend({
  observedAt: timestamp,
  source,
})
const financialIdentity = {
  beforePlatformUserId: platformUserId,
  afterPlatformUserId: platformUserId,
}
export const AccountBankRecordSchema = z.strictObject({
  id: platformUserId,
  name: text.max(160),
  account_number: text
    .min(1)
    .max(64)
    .refine((value) => /^[*xX\u2022\s-]*[*xX\u2022][*xX\u2022\s-]*\d{1,4}$/.test(value)),
  routing_number: z.string().regex(/^\d{9}$/),
  spending_type: text.min(1).max(64),
  user_id: platformUserId,
  hide_name: z.boolean(),
  is_default: z.boolean(),
})
const bankRecords = z
  .array(AccountBankRecordSchema)
  .max(20)
  .refine(
    (records) => new Set(records.map((record) => record.id)).size === records.length,
  )
export const AccountCurrentInputSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('authenticated'),
    reason: z.literal('current_user'),
    platformUserId,
    isAccountBanned: z.boolean().optional(),
    profileUrl: z.string().max(2048).nullable().optional(),
  }),
  z.strictObject({
    status: z.literal('logged_out'),
    reason: z.literal('current_access_denied'),
    httpStatus: z.union([z.literal(200), z.literal(401), z.literal(403)]),
    code: z.literal(106),
    messageCode: z.literal('access_denied'),
  }),
])
const analysis = z
  .strictObject({
    tags: tags.optional(),
    summary: summary.optional(),
    rating: rating.optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined))
const failureCode = z.enum([
  'unreadable',
  'network_error',
  'identity_mismatch',
  'invalid_response',
])
export const AccountObservationInputSchema = z
  .strictObject({
    ...bindingContext,
    sequence,
    observedAt: timestamp,
    source,
    current: AccountCurrentInputSchema.optional(),
    wallet: z
      .strictObject({
        ...financialIdentity,
        available: AccountMoneyInputSchema.nullable().optional(),
        pending: AccountMoneyInputSchema.nullable().optional(),
      })
      .refine((value) => value.available !== undefined || value.pending !== undefined)
      .optional(),
    bankAccounts: z
      .strictObject({
        ...financialIdentity,
        records: bankRecords,
      })
      .optional(),
    analysis: analysis.optional(),
    failures: z
      .array(
        z.strictObject({
          domain: AccountObservationDomainSchema,
          code: failureCode,
        }),
      )
      .min(1)
      .max(6)
      .optional(),
  })
  .superRefine((value, context) => {
    if (
      !value.current &&
      !value.wallet &&
      !value.bankAccounts &&
      !value.analysis &&
      !value.failures
    ) {
      context.addIssue({ code: 'custom', message: 'Missing observation result' })
    }
    if (
      (value.current ||
        value.wallet ||
        value.bankAccounts ||
        value.failures?.some((failure) => failure.domain !== 'analysis')) &&
      value.source !== 'official'
    ) {
      context.addIssue({ code: 'custom', message: 'Official evidence required' })
    }
  })
const windowContext = {
  windowId: z.uuid(),
  accountId: z.uuid(),
  bindingRevision: z.uuid(),
  observedAt: timestamp,
  source: z.literal('official'),
}
export const WindowSessionObservationSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...windowContext,
    status: z.literal('authenticated'),
    reason: z.literal('current_user'),
    platformUserId,
  }),
  z.strictObject({
    ...windowContext,
    status: z.literal('logged_out'),
    reason: z.literal('current_access_denied'),
    platformUserId: z.null(),
  }),
])
export const AccountDomainCheckSchema = z.strictObject({
  sequence,
  operationId: z.uuid(),
  observedAt: timestamp,
  source,
  outcome: z.enum(['succeeded', 'failed']),
  code: failureCode.optional(),
})
const checkKey = z
  .string()
  .refine(
    (value) =>
      AccountObservationDomainSchema.safeParse(value).success ||
      (value.startsWith('session:') && z.uuid().safeParse(value.slice(8)).success),
  )
export const AccountObservationStateSchema = z.strictObject({
  platformUserId: platformUserId.optional(),
  tags: tags.optional(),
  summary: summary.optional(),
  rating: rating.optional(),
  wallet: z
    .strictObject({
      available: AccountObservedMoneySchema.nullable(),
      pending: AccountObservedMoneySchema.nullable(),
    })
    .optional(),
  bankAccounts: z
    .strictObject({
      records: bankRecords,
      observedAt: timestamp,
      source: z.literal('official'),
      windowId: z.uuid(),
      bindingRevision: z.uuid(),
    })
    .optional(),
  statusEvidence: z
    .strictObject({
      status,
      source: z.enum(['official', 'page']),
      observedAt: timestamp,
      reason: z.enum(['current_account_banned', 'legacy_status']),
    })
    .optional(),
  identityEvidence: z
    .strictObject({
      platformUserId,
      observedAt: timestamp,
      source: z.literal('official'),
      windowId: z.uuid(),
      bindingRevision: z.uuid(),
    })
    .optional(),
  homepageEvidence: z
    .strictObject({
      url: z.string().max(2048),
      platformUserId,
      observedAt: timestamp,
      source: z.literal('current'),
      windowId: z.uuid(),
      bindingRevision: z.uuid(),
    })
    .optional(),
  sessions: z.record(z.uuid(), WindowSessionObservationSchema),
  checks: z.record(checkKey, AccountDomainCheckSchema),
})
export const AccountObservationResultSchema = z.strictObject({
  operationId: z.uuid(),
  accountId: z.uuid(),
  applied: z.boolean(),
  storageDurable: z.boolean(),
})
export const AccountAgentSnapshotInputSchema = z.strictObject({ windowId: z.uuid() })

/** Deliberately distinct from stored state: no financial values, lists or payloads. */
export const AccountAgentObservationSchema = AccountObservationStateSchema.pick({
  platformUserId: true,
  tags: true,
  summary: true,
  rating: true,
  statusEvidence: true,
  identityEvidence: true,
})
export const AccountAgentSnapshotResultSchema = z.strictObject({
  account: z.strictObject({
    accountId: z.uuid(),
    account: z.string().min(1).max(190),
    status,
    homepageUrl: z.string().max(2048),
    platformUserId: platformUserId.nullable(),
    observation: AccountAgentObservationSchema.nullable(),
  }),
  windowId: z.uuid(),
  bindingRevision: z.uuid(),
  session: WindowSessionObservationSchema.nullable(),
})

export type AccountObservationDomain = z.infer<typeof AccountObservationDomainSchema>
export type AccountObservationReserveInput = z.infer<
  typeof AccountObservationReserveInputSchema
>
export type AccountObservationReserveResult = z.infer<
  typeof AccountObservationReserveResultSchema
>
export type AccountObservationInput = z.infer<typeof AccountObservationInputSchema>
export type AccountObservationResult = z.infer<typeof AccountObservationResultSchema>
export type AccountObservationState = z.infer<typeof AccountObservationStateSchema>
export type AccountObservedMoney = z.infer<typeof AccountObservedMoneySchema>
export type AccountBankRecord = z.infer<typeof AccountBankRecordSchema>
export type WindowSessionObservation = z.infer<typeof WindowSessionObservationSchema>
export type AccountAgentSnapshotInput = z.infer<typeof AccountAgentSnapshotInputSchema>
export type AccountAgentSnapshotResult = z.infer<typeof AccountAgentSnapshotResultSchema>
