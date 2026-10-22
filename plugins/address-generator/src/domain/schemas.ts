import { z } from 'zod'

import { invalidRequest } from './errors.js'
import { isCountryCode } from '../services/catalog.js'

const countrySchema = z
  .string()
  .trim()
  .refine(isCountryCode, { message: '不支持的国家代码' })

const shortText = (max: number) => z.string().trim().min(1).max(max)
const optionalText = (max: number) => z.string().trim().max(max).nullable()

export const AddressInputSchema = z.strictObject({
  street: shortText(200),
  houseNumber: shortText(32),
  city: shortText(120),
  postalCode: shortText(16),
  countryCode: countrySchema,
  state: optionalText(120),
  county: optionalText(120),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  source: z.enum(['osm', 'map']),
  sourceUrl: z.string().trim().max(2048),
  approximate: z.boolean(),
})

export const ProfileSchema = AddressInputSchema.extend({
  id: z.string().trim().min(1).max(64),
  firstName: shortText(80),
  lastName: shortText(80),
  username: z
    .string()
    .trim()
    .min(4)
    .max(20)
    .regex(/^[a-z][a-z0-9._-]*$/, { message: '用户名格式无效' }),
})

export const GenerateInputSchema = z.strictObject({
  country: countrySchema,
  cityId: z.string().trim().min(1).max(64),
  count: z.number().int().min(1).max(50),
})

export const ProfileInputSchema = z.strictObject({
  address: AddressInputSchema,
})

export const ItemsInputSchema = z.strictObject({
  items: z.array(ProfileSchema).min(1).max(50),
})

export const ConfigureInputSchema = z.strictObject({
  /** Omitted keeps the stored key; null or an empty string clears it. */
  apiKey: z.string().max(512).nullable().optional(),
})

export function parseOrThrow<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join('.') ?? ''
    throw invalidRequest(path === '' ? '请求参数无效' : `请求参数无效：${path}`)
  }
  return parsed.data
}

export type AddressInput = z.infer<typeof AddressInputSchema>
export type ProfileInput = z.infer<typeof ProfileSchema>
export type GenerateInput = z.infer<typeof GenerateInputSchema>
export type ConfigureInput = z.infer<typeof ConfigureInputSchema>
