import { z } from 'zod'

export const ReviewResultSchema = z.strictObject({
  decision: z.enum(['pass', 'skip', 'review']),
  confidence: z.number().finite().min(0).max(1),
  reason: z.string().trim().min(1).max(1000),
})

export const TargetSchema = z
  .strictObject({
    css: z.string().min(1).max(512).optional(),
    role: z
      .string()
      .regex(/^[a-z]{2,32}$/u)
      .optional(),
    name: z.string().min(1).max(512).optional(),
    label: z.string().min(1).max(512).optional(),
    placeholder: z.string().min(1).max(512).optional(),
    testId: z.string().min(1).max(512).optional(),
    index: z.number().int().min(0).max(99).optional(),
  })
  .superRefine((target, context) => {
    const selectors = [
      target.css,
      target.role,
      target.label,
      target.placeholder,
      target.testId,
    ].filter((value) => value !== undefined)
    if (
      selectors.length > 1 ||
      (!selectors.length && target.index === undefined) ||
      (target.name !== undefined && target.role === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An unambiguous browser target is required.',
      })
    }
  })

export const BrowserSnapshotSchema = z
  .strictObject({
    url: z.string().url().max(4096),
    title: z.string().max(1000),
    text: z.string().max(100_000),
    controls: z
      .array(
        z.strictObject({
          index: z.number().int().min(0).max(99),
          role: z.string().min(1).max(64),
          name: z.string().max(512),
          type: z.string().max(64).optional(),
          value: z.string().max(2048).optional(),
        }),
      )
      .max(100),
  })
  .superRefine((snapshot, context) => {
    if (
      new Set(snapshot.controls.map((control) => control.index)).size !==
      snapshot.controls.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Browser control indices must be unique.',
      })
    }
  })

export const BrowserPlanSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('fill'),
    target: TargetSchema,
    value: z.string().max(6000),
  }),
  z.strictObject({
    action: z.literal('select'),
    target: TargetSchema,
    value: z.string().max(6000),
  }),
  z.strictObject({ action: z.literal('click'), target: TargetSchema }),
  z.strictObject({ action: z.literal('upload'), target: TargetSchema }),
  z.strictObject({ action: z.literal('submit'), target: TargetSchema }),
  z.strictObject({
    action: z.literal('done'),
    reason: z.string().trim().min(1).max(1000),
  }),
  z.strictObject({
    action: z.literal('review'),
    reason: z.string().trim().min(1).max(1000),
  }),
])

export type ReviewResult = z.infer<typeof ReviewResultSchema>
export type Target = z.infer<typeof TargetSchema>
export type BrowserSnapshot = z.infer<typeof BrowserSnapshotSchema>
export type BrowserPlan = z.infer<typeof BrowserPlanSchema>

// This rejects scripts and obvious untranslated prose; the typed English
// judgment remains necessary for semantic language validation.
export function isEnglishText(value: string): boolean {
  return (
    /[a-z]/iu.test(value) &&
    !/(?=\p{L})\P{Script_Extensions=Latin}/u.test(value) &&
    !/\b(?:cette|chemise|avec une|en bon|vendre|descripci[oó]n|camiseta|talla|gebraucht|zustand|verkaufen|questa|camicia)\b/iu.test(
      value,
    )
  )
}

export function redactText(value: string, secrets: readonly string[] = []): string {
  let result = value
    .replace(/\bBearer\s+[a-z0-9._~+/-]+=*/giu, 'Bearer [REDACTED]')
    .replace(
      /\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|authorization|cookie|secret)\s*["']?\s*[:=]\s*["']?[^"'\s<>&,;]+/giu,
      '[REDACTED]',
    )
    .replace(/\b(?:https?:\/\/)[^\s"'<>]+/giu, (raw) => {
      try {
        const url = new URL(raw)
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        return url.href
      } catch {
        return '[REDACTED URL]'
      }
    })
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join('[REDACTED]')
  }
  return result
}

export function contextJson(value: unknown, secrets: readonly string[] = []): string {
  return (
    JSON.stringify(value, (key, entry: unknown) => {
      if (
        typeof entry === 'boolean' &&
        /^(?:is[_-]?)?email[_-]?(?:verified|valid)$/iu.test(key)
      )
        return entry
      if (/password|passwd|secret|token|cookie|authorization|api.?key|email/iu.test(key))
        return '[REDACTED]'
      return typeof entry === 'string' ? redactText(entry, secrets) : entry
    }) ?? 'null'
  )
}
