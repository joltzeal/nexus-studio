import { z } from 'zod'

const id = z.string().trim().min(1).max(64)
const text = (max: number) => z.string().trim().min(1).max(max)
const region = z.string().trim().max(120).nullable()

/** A wire snapshot owned by this plugin, independent of the address collection. */
export const AccountAddressProfileSchema = z.strictObject({
  id,
  street: text(200),
  houseNumber: text(32),
  city: text(120),
  postalCode: text(16),
  countryCode: z.enum(['US', 'FR', 'DE', 'GB', 'NL', 'BE', 'ES', 'IT', 'PL', 'PT']),
  state: region,
  county: region,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  source: z.enum(['osm', 'map']),
  sourceUrl: z.string().trim().max(2048),
  approximate: z.boolean(),
  firstName: text(80),
  lastName: text(80),
  username: z
    .string()
    .trim()
    .min(4)
    .max(20)
    .regex(/^[a-z][a-z0-9._-]*$/),
})

export const AssignedAccountAddressSchema = AccountAddressProfileSchema.extend({
  linkedAt: z.iso.datetime({ offset: true }).max(64),
})

export const AccountAddressTargetsInputSchema = z.strictObject({
  query: z.string().trim().max(200).optional(),
  page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
})

export const AccountAddressSetInputSchema = z.strictObject({
  accountId: id,
  profile: AccountAddressProfileSchema.nullable(),
  expectedProfileId: id.nullable().optional(),
})

export type AccountAddressProfile = z.infer<typeof AccountAddressProfileSchema>
export type AssignedAccountAddress = z.infer<typeof AssignedAccountAddressSchema>
