import { z } from 'zod'

/** Host-private account pool hook; never expose through generic WebView RPC. */
export const WINDOW_DETACH_METHOD = 'window.detach' as const

const windowIdSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => value === value.trim(),
    'windowId must not contain surrounding whitespace',
  )

export const WindowDetachInputSchema = z.strictObject({
  windowId: windowIdSchema,
})

export const WindowDetachResultSchema = z.strictObject({
  windowId: windowIdSchema,
  unbound: z.boolean(),
})

export type WindowDetachInput = Readonly<z.infer<typeof WindowDetachInputSchema>>
export type WindowDetachResult = Readonly<z.infer<typeof WindowDetachResultSchema>>
