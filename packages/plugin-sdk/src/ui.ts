import { z } from 'zod'

const id = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9._:-]+$/)
const label = z.string().min(1).max(200)
const value = z.string().max(8192)

export const PluginIconSchema = z.strictObject({
  viewBox: z.literal('0 0 24 24'),
  paths: z
    .array(
      z
        .string()
        .min(1)
        .max(8192)
        .regex(/^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+ \t\r\n\f\v-]+$/),
    )
    .min(1)
    .max(8),
})

export const PluginUiDeclarationSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    navigation: z.strictObject({ icon: PluginIconSchema }).optional(),
    services: z
      .array(
        z.strictObject({
          id,
          pluginId: z
            .string()
            .min(1)
            .max(96)
            .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/)
            .refine((value) => value.split('.').every((label) => label.length <= 48)),
          capability: z.string().min(1).max(96),
          methods: z.array(id).min(1).max(20),
        }),
      )
      .max(10)
      .default([]),
    profileTable: z
      .strictObject({
        title: label,
        viewId: id,
        capability: z.string().min(1).max(96),
        icon: PluginIconSchema,
      })
      .optional(),
  })
  .superRefine((ui, ctx) => {
    if (!ui.navigation && !ui.profileTable)
      ctx.addIssue({
        code: 'custom',
        message: 'Declare a navigation icon or Profile panel',
      })
    if (!ui.profileTable && ui.services.length)
      ctx.addIssue({
        code: 'custom',
        path: ['services'],
        message: 'UI services require a Profile panel',
      })
    if (new Set(ui.services.map((service) => service.id)).size !== ui.services.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate UI service ID' })
    for (const service of ui.services) {
      if (
        new Set(service.methods).size !== service.methods.length ||
        service.methods.some((method) =>
          /^(?:ui\.|transfer\.|window\.detach$)/.test(method),
        )
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid UI service methods' })
    }
  })

export const PluginUiActionSchema = z.strictObject({
  id,
  label,
  tone: z.enum(['neutral', 'primary', 'danger']).default('neutral'),
  placement: z.enum(['header', 'body']).default('body'),
  submit: z.boolean().default(false),
  disabled: z.boolean().default(false),
  disabledReason: label.optional(),
  announce: z.boolean().default(false),
  cancelTasks: z.array(id).max(64).default([]),
})

export const PluginUiNoticeSchema = z.strictObject({
  id,
  title: label,
  message: value,
  tone: z.enum(['success', 'warning', 'error']).default('success'),
  copyText: z.string().min(1).max(512).optional(),
  speech: z
    .strictObject({
      channel: z.enum(['sms', 'email']),
      code: z.string().regex(/^(?:\d{4}|\d{6})$/),
    })
    .optional(),
})

export const PluginUiTaskSchema = z.strictObject({
  id,
  label,
  deadlineAt: z.number().int().positive(),
  pollIntervalMs: z.number().int().min(1000).max(30_000).default(5000),
  timeoutNotice: PluginUiNoticeSchema,
})
export const PluginUiTaskResultSchema = z.strictObject({
  state: z.enum(['pending', 'done']),
  notices: z.array(PluginUiNoticeSchema).max(10).default([]),
})
export const PluginUiProfileStatusSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        profileId: z.uuid(),
        tone: z.enum(['neutral', 'success', 'warning', 'danger', 'info']),
        label,
      }),
    )
    .max(200),
})

export const PluginUiServiceAvailabilitySchema = z.record(
  id,
  z.strictObject({
    available: z.boolean(),
    identity: z.string().max(512).nullable(),
  }),
)
export const PluginUiServiceResultsSchema = z.record(
  id,
  z.discriminatedUnion('ok', [
    z.strictObject({
      ok: z.literal(true),
      value: z.unknown(),
      identity: z.string().max(512),
    }),
    z.strictObject({ ok: z.literal(false), code: z.string().min(1).max(96) }),
  ]),
)
export const PluginUiServiceRequestSchema = z.strictObject({
  kind: z.literal('service-request'),
  requests: z
    .array(
      z.strictObject({
        id,
        serviceId: id,
        method: id,
        payload: z.unknown(),
      }),
    )
    .min(1)
    .max(8),
})

export const PluginUiFieldSchema = z.strictObject({
  id,
  label,
  type: z.enum(['text', 'password', 'textarea', 'select']),
  value,
  required: z.boolean().default(false),
  maxLength: z.number().int().min(1).max(8192).default(2048),
  options: z
    .array(z.strictObject({ value: z.string().max(200), label }))
    .max(2000)
    .default([]),
})

export const PluginUiViewSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    revision: z.string().min(1).max(128),
    title: label,
    saved: z.boolean().default(false),
    pendingChanges: z.boolean().default(false),
    tasks: z.array(PluginUiTaskSchema).max(10).default([]),
    cancelledTasks: z.array(id).max(64).default([]),
    notices: z.array(PluginUiNoticeSchema).max(10).default([]),
    refresh: z
      .strictObject({
        actionId: id,
        intervalMs: z.number().int().min(1000).max(30_000),
      })
      .optional(),
    sections: z
      .array(
        z.strictObject({
          id,
          title: label,
          text: value.optional(),
          properties: z
            .array(
              z.strictObject({
                label,
                value,
                copyable: z.boolean().default(false),
                href: z
                  .url()
                  .max(2048)
                  .refine((url) => {
                    const parsed = new URL(url)
                    return (
                      ['https:', 'http:'].includes(parsed.protocol) &&
                      !parsed.username &&
                      !parsed.password
                    )
                  })
                  .optional(),
              }),
            )
            .max(40)
            .default([]),
          fields: z.array(PluginUiFieldSchema).max(30).default([]),
          actions: z.array(PluginUiActionSchema).max(100).default([]),
        }),
      )
      .max(20),
    actions: z.array(PluginUiActionSchema).max(20).default([]),
    confirmation: z
      .strictObject({
        title: label,
        message: value,
        confirmActionId: id,
        confirmLabel: label,
        cancelActionId: id,
      })
      .optional(),
  })
  .superRefine((view, ctx) => {
    const actions = [
      ...view.actions,
      ...view.sections.flatMap((section) => section.actions),
    ]
    const fields = view.sections.flatMap((section) => section.fields)
    for (const [kind, ids] of [
      ['section', view.sections.map((section) => section.id)],
      ['action', actions.map((action) => action.id)],
      ['field', fields.map((field) => field.id)],
    ] as const) {
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: 'custom', message: `Duplicate ${kind} ID` })
    }
    if (
      view.confirmation &&
      !actions.some((action) => action.id === view.confirmation?.confirmActionId)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Confirmation action is missing' })
    }
    if (new Set(view.tasks.map((task) => task.id)).size !== view.tasks.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate task ID' })
    if (
      view.refresh &&
      (fields.length > 0 ||
        !actions.some((action) => action.id === view.refresh?.actionId && !action.submit))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Refresh requires a declared non-form action',
      })
  })

export type PluginIcon = z.infer<typeof PluginIconSchema>
export type PluginUiDeclaration = z.infer<typeof PluginUiDeclarationSchema>
export type PluginUiView = z.infer<typeof PluginUiViewSchema>
export type PluginUiViewInput = z.input<typeof PluginUiViewSchema>
export type PluginUiAction = z.infer<typeof PluginUiActionSchema>
export type PluginUiField = z.infer<typeof PluginUiFieldSchema>
export type PluginUiTask = z.infer<typeof PluginUiTaskSchema>
export type PluginUiTaskResult = z.infer<typeof PluginUiTaskResultSchema>
export type PluginUiNotice = z.infer<typeof PluginUiNoticeSchema>
export type PluginUiProfileStatus = z.infer<typeof PluginUiProfileStatusSchema>
export type PluginUiServiceResults = z.infer<typeof PluginUiServiceResultsSchema>
export type PluginUiServiceAvailability = z.infer<
  typeof PluginUiServiceAvailabilitySchema
>
