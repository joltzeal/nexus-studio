import { z } from 'zod'

// Receipts never expire or get silently evicted: exhaustion fails before mutation.
export const MAX_OBSERVATION_OPERATIONS = 100_000
export const AccountObservationOperationSchema = z.strictObject({
  operationId: z.uuid(),
  accountId: z.uuid(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  applied: z.boolean(),
})
export type AccountObservationOperation = z.infer<
  typeof AccountObservationOperationSchema
>
