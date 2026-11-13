import { z } from 'zod'

export const SALES_AGENT_PLUGIN_ID = 'studio.sales-agent'
export const SALES_AGENT_CAPABILITY = 'sales.agent'
export const AGENT_METHODS = [
  'salesAgent.settings.get',
  'salesAgent.settings.save',
  'salesAgent.models.test',
  'salesAgent.notifications.send',
  'salesAgent.jobs.step',
  'configuration.export',
  'configuration.validate',
  'configuration.import',
] as const

const shortText = z.string().trim().max(200)
const uuid = z.uuid()
const timestamp = z.iso.datetime({ offset: true }).max(64)
const origin = z
  .string()
  .max(200)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        url.origin === value &&
        /^www\.vinted\.(?:com|co\.uk|fr|de|it|es|nl|be|at|pl|pt|cz|sk|lt|lu|se|dk|fi|hr|hu|ro|gr|ie)$/.test(
          url.hostname,
        )
      )
    } catch {
      return false
    }
  }, '请选择有效的 Vinted 站点')

export const AgentPresetSchema = z.enum(['inspect_accounts', 'post_listing', 'message'])
export const AgentJobStateSchema = z.enum([
  'queued',
  'running',
  'paused',
  'completed',
  'blocked',
  'review_required',
  'result_unknown',
  'sync_pending',
  'failed',
  'cancelled',
  'skipped',
])
export const AgentBatchStateSchema = z.enum([
  'queued',
  'running',
  'paused',
  'completed',
  'needs_attention',
  'cancelled',
])
export const AgentScopeSchema = z.strictObject({
  batchId: uuid,
  jobId: uuid,
  windowId: uuid,
  accountId: uuid,
  leaseId: uuid,
  fence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})
export const AgentProductOverrideSchema = z.strictObject({
  productId: uuid,
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().trim().min(1).max(6000).optional(),
  price: z.number().finite().positive().max(100_000_000).optional(),
  currency: z.enum(['USD', 'GBP', 'EUR']).optional(),
  category: shortText.optional(),
  condition: z.string().trim().max(120).optional(),
  brand: z.string().trim().max(120).optional(),
  size: z.string().trim().max(120).optional(),
})
export const AgentMessageSchema = z.strictObject({
  conversationId: z.string().regex(/^\d{1,32}$/),
  text: z.string().trim().min(1).max(4000),
})
export const AgentAssignmentSchema = z.strictObject({
  windowId: uuid,
  productIds: z.array(uuid).max(100).default([]),
  overrides: z.array(AgentProductOverrideSchema).max(100).default([]),
  messages: z.array(AgentMessageSchema).max(100).default([]),
})
export const AgentBatchCreateSchema = z
  .strictObject({
    operationId: uuid,
    preset: AgentPresetSchema,
    instruction: z.string().trim().max(4000).default(''),
    concurrency: z.number().int().min(1).max(10).default(3),
    assignments: z.array(AgentAssignmentSchema).min(1).max(100),
  })
  .superRefine((draft, context) => {
    const windows = new Set<string>()
    const products = new Set<string>()
    let messages = 0
    for (const assignment of draft.assignments) {
      if (windows.has(assignment.windowId))
        context.addIssue({ code: 'custom', message: '同一批次不能重复选择窗口' })
      windows.add(assignment.windowId)
      for (const id of assignment.productIds) {
        if (products.has(id))
          context.addIssue({ code: 'custom', message: '每件商品只能分配给一个窗口' })
        products.add(id)
      }
      const overridden = new Set<string>()
      for (const override of assignment.overrides) {
        if (
          !assignment.productIds.includes(override.productId) ||
          overridden.has(override.productId)
        )
          context.addIssue({
            code: 'custom',
            message: '商品编辑必须属于当前分配且不能重复',
          })
        overridden.add(override.productId)
      }
      if (draft.preset === 'post_listing' && !assignment.productIds.length)
        context.addIssue({ code: 'custom', message: '请为每个执行窗口分配商品' })
      if (draft.preset === 'message' && !assignment.messages.length)
        context.addIssue({ code: 'custom', message: '请指定每个窗口的会话与消息内容' })
      if (draft.preset !== 'post_listing' && assignment.productIds.length)
        context.addIssue({ code: 'custom', message: '当前任务不接受商品分配' })
      if (draft.preset !== 'message' && assignment.messages.length)
        context.addIssue({ code: 'custom', message: '当前任务不接受消息分配' })
      messages += assignment.messages.length
    }
    if (products.size > 100 || messages > 100)
      context.addIssue({
        code: 'custom',
        message: '每批最多执行 100 件商品或 100 条消息',
      })
  })

const ModelEndpointSchema = z.strictObject({
  baseUrl: z
    .string()
    .trim()
    .url()
    .max(2048)
    .refine((value) => {
      if (!URL.canParse(value)) return false
      const url = new URL(value)
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      )
    }, '模型服务需要 HTTPS 或本机地址'),
  apiKey: z.string().trim().min(1).max(4096),
  model: z.string().trim().min(1).max(200),
})
export const AgentExecutionSettingsSchema = z.strictObject({
  modelConcurrency: z.number().int().min(1).max(10).default(3),
  modelRequestsPerMinute: z.number().int().min(1).max(600).default(60),
  providerConcurrency: z
    .strictObject({
      cloakbrowser: z.number().int().min(1).max(10).default(3),
      adspower: z.number().int().min(1).max(10).default(3),
      bitbrowser: z.number().int().min(1).max(10).default(3),
    })
    .prefault({}),
  maxReadRetries: z.number().int().min(0).max(5).default(2),
  retryBaseMs: z.number().int().min(500).max(30_000).default(2000),
  platformCooldownMs: z.number().int().min(1000).max(300_000).default(30_000),
  maxBatchModelRequests: z.number().int().min(1).max(100_000).default(10_000),
  maxBatchCostUsd: z.number().finite().positive().max(1_000_000).nullable().default(null),
})
const ModelPricingSchema = z
  .strictObject({
    inputPerMillionUsd: z.number().finite().min(0).max(100_000).nullable().default(null),
    outputPerMillionUsd: z.number().finite().min(0).max(100_000).nullable().default(null),
  })
  .prefault({})
export const AgentNotificationsSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    baseUrl: ModelEndpointSchema.shape.baseUrl.default('https://api.day.app'),
    deviceKey: z.string().trim().max(4096).default(''),
    onCompleted: z.boolean().default(true),
    onAttention: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.enabled && !value.deviceKey)
      ctx.addIssue({ code: 'custom', message: '开启通知前请填写 Bark 设备 Key' })
  })
export const AgentSettingsSchema = z
  .strictObject({
    decision: ModelEndpointSchema.extend({
      protocol: z.enum(['typesafe', 'openai']).default('typesafe'),
    }),
    generation: ModelEndpointSchema,
    requestTimeoutMs: z.number().int().min(5000).max(90_000).default(60_000),
    maxStepsPerItem: z.number().int().min(5).max(60).default(30),
    maxCopyRewrites: z.number().int().min(0).max(2).default(2),
    reviewThreshold: z.number().min(0.5).max(1).default(0.8),
    execution: AgentExecutionSettingsSchema.prefault({}),
    pricing: z
      .strictObject({ decision: ModelPricingSchema, generation: ModelPricingSchema })
      .prefault({}),
    notifications: AgentNotificationsSchema.prefault({}),
    retention: z
      .strictObject({
        enabled: z.boolean().default(false),
        days: z.number().int().min(1).max(3650).default(30),
      })
      .prefault({}),
  })
  .superRefine((value, ctx) => {
    if (
      value.execution.maxBatchCostUsd !== null &&
      Object.values(value.pricing).some(
        (price) =>
          price.inputPerMillionUsd === null || price.outputPerMillionUsd === null,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: '设置费用预算前，请完整填写两个模型的价格',
      })
  })
export const AgentImageSchema = z.strictObject({
  id: uuid,
  artifactId: uuid,
  name: z.string().min(1).max(200),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  bytes: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export const AgentProductSnapshotSchema = z.object({
  id: uuid,
  revision: z.number().int().positive(),
  name: z.string().max(200),
  title: z.string().max(500),
  description: z.string().max(6000),
  price: z.number().finite().positive().max(100_000_000),
  currency: z.enum(['USD', 'GBP', 'EUR']),
  category: shortText.default(''),
  condition: z.string().min(1).max(120),
  brand: z.string().max(120).default(''),
  size: z.string().max(120).default(''),
  tags: z.array(z.string().max(64)).max(20).default([]),
  images: z.array(AgentImageSchema).min(1).max(12),
})
export const AgentAccountSnapshotSchema = z.object({
  accountId: uuid,
  account: z.string().max(320),
  status: z.enum(['active', 'pending', 'limited', 'blocked']),
  homepageUrl: z.string().max(2048),
  platformUserId: z.string().regex(/^\d{1,32}$/),
})
export const AgentJobSnapshotSchema = z.object({
  windowId: uuid,
  windowName: z.string().max(200),
  providerId: z.enum(['cloakbrowser', 'adspower', 'bitbrowser']),
  connectionId: z.string().min(1).max(200),
  profileId: z.string().min(1).max(200),
  platformOrigin: origin,
  account: AgentAccountSnapshotSchema,
  products: z.array(AgentProductSnapshotSchema).max(100),
  messages: z.array(AgentMessageSchema).max(100),
})
export const AgentStepInputSchema = z.strictObject({
  scope: AgentScopeSchema,
  snapshot: AgentJobSnapshotSchema,
  preset: AgentPresetSchema,
  instruction: z.string().max(4000),
  settings: AgentSettingsSchema,
})
export const AgentStepResultSchema = z.strictObject({
  state: z.enum([
    'continue',
    'completed',
    'blocked',
    'review_required',
    'result_unknown',
    'sync_pending',
    'skipped',
  ]),
  phase: z.string().min(1).max(100),
  message: z.string().max(1000).optional(),
  retry: z
    .strictObject({
      attempt: z.number().int().min(1).max(5),
      maxAttempts: z.number().int().min(1).max(5),
      nextAttemptAt: timestamp,
      code: z.string().min(1).max(100),
    })
    .optional(),
  progress: z
    .strictObject({
      currentIndex: z.number().int().min(0).max(100),
      published: z.number().int().min(0).max(100),
      skipped: z.number().int().min(0).max(100),
      currentProductId: uuid.optional(),
    })
    .optional(),
  itemUpdates: z
    .array(
      z.strictObject({
        productId: uuid,
        state: z.enum([
          'pending',
          'reviewing',
          'preparing',
          'submitting',
          'published',
          'skipped',
          'review_required',
          'result_unknown',
          'sync_pending',
          'failed',
          'cancelled',
        ]),
        reason: z.string().max(1000).default(''),
        title: z.string().max(500).optional(),
        description: z.string().max(6000).optional(),
      }),
    )
    .max(2)
    .optional(),
})
export const AgentJobViewSchema = z.object({
  id: uuid,
  windowId: uuid,
  windowName: z.string(),
  accountId: uuid,
  account: z.string(),
  state: AgentJobStateSchema,
  phase: z.string(),
  message: z.string().default(''),
  productCount: z.number().int().nonnegative(),
  progress: AgentStepResultSchema.shape.progress.unwrap().optional(),
  retry: AgentStepResultSchema.shape.retry.unwrap().optional(),
  takeover: z.enum(['none', 'stopping', 'ready', 'blocked']).default('none'),
  createdAt: timestamp,
  updatedAt: timestamp,
})
export const AgentBatchViewSchema = z.object({
  id: uuid,
  preset: AgentPresetSchema,
  instruction: z.string(),
  state: AgentBatchStateSchema,
  concurrency: z.number().int().min(1).max(10),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  attention: z.number().int().nonnegative(),
  createdAt: timestamp,
  updatedAt: timestamp,
})
export const AgentBatchPageSchema = z.object({
  items: z.array(AgentBatchViewSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
})
export const AgentBatchDetailSchema = z.object({
  batch: AgentBatchViewSchema,
  jobs: z.array(AgentJobViewSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
})
export const AgentEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  batchId: uuid,
  jobId: uuid.nullable(),
  kind: z.string().max(100),
  message: z.string().max(1000),
  createdAt: timestamp,
})
export const AgentEventPageSchema = z.object({
  items: z.array(AgentEventSchema).max(100),
  cursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
})

export type AgentBatchCreate = z.infer<typeof AgentBatchCreateSchema>
export type AgentAssignment = z.infer<typeof AgentAssignmentSchema>
export type AgentPreset = z.infer<typeof AgentPresetSchema>
export type AgentSettings = z.infer<typeof AgentSettingsSchema>
export type AgentScope = z.infer<typeof AgentScopeSchema>
export type AgentStepInput = z.infer<typeof AgentStepInputSchema>
export type AgentStepResult = z.infer<typeof AgentStepResultSchema>
export type AgentJobSnapshot = z.infer<typeof AgentJobSnapshotSchema>
export type AgentProductSnapshot = z.infer<typeof AgentProductSnapshotSchema>
export type AgentProductOverride = z.infer<typeof AgentProductOverrideSchema>
export type AgentBatchView = z.infer<typeof AgentBatchViewSchema>
export type AgentBatchPage = z.infer<typeof AgentBatchPageSchema>
export type AgentBatchDetail = z.infer<typeof AgentBatchDetailSchema>
export type AgentJobView = z.infer<typeof AgentJobViewSchema>
export type AgentEvent = z.infer<typeof AgentEventSchema>
export type AgentEventPage = z.infer<typeof AgentEventPageSchema>

export const AgentItemControlSchema = z
  .strictObject({
    jobId: uuid,
    productId: uuid,
    action: z.enum(['skip', 'revise', 'approve']),
    override: AgentProductOverrideSchema.omit({ productId: true }).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.action === 'revise' &&
        (!value.override || Object.keys(value.override).length === 0)) ||
      (value.action === 'skip' && value.override)
    )
      ctx.addIssue({ code: 'custom', message: '请选择有效的未提交商品操作与修改内容' })
  })
export const AgentControlsSchema = z
  .strictObject({
    revision: z.number().int().nonnegative(),
    items: z
      .array(
        z.strictObject({
          productId: AgentItemControlSchema.shape.productId,
          action: AgentItemControlSchema.shape.action,
          override: AgentItemControlSchema.shape.override,
          revision: z.number().int().positive(),
        }),
      )
      .max(100),
  })
  .superRefine((value, ctx) => {
    if (
      value.items.some((item) => item.revision > value.revision) ||
      value.items.some(
        (item) =>
          (item.action === 'revise' &&
            (!item.override || Object.keys(item.override).length === 0)) ||
          (item.action === 'skip' && item.override),
      ) ||
      new Set(value.items.map((item) => item.productId)).size !== value.items.length
    )
      ctx.addIssue({ code: 'custom', message: '商品操作修订或关系无效' })
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 800 * 1024)
      ctx.addIssue({ code: 'custom', message: '累计商品修改不能超过 800 KiB' })
  })
export const AgentModelAcquireSchema = z.strictObject({
  requestId: uuid,
  kind: z.enum(['decision', 'generation']),
})
export const AgentModelCompleteSchema = z.strictObject({
  requestId: uuid,
  outcome: z.enum(['succeeded', 'failed', 'cancelled']),
  elapsedMs: z.number().int().min(0).max(120_000),
  inputTokens: z.number().int().min(0).max(100_000_000).nullable().optional(),
  outputTokens: z.number().int().min(0).max(100_000_000).nullable().optional(),
  status: z.number().int().min(100).max(599).optional(),
})
export const AgentSavedPlanSchema = z
  .strictObject({
    preset: AgentPresetSchema,
    instruction: z.string().trim().max(4000).default(''),
    concurrency: z.number().int().min(1).max(10).default(3),
    productIds: z.array(uuid).max(100).default([]),
    windowIds: z.array(uuid).max(100).default([]),
    assignments: z.array(AgentAssignmentSchema).max(100).default([]),
    unassignedOverrides: z.array(AgentProductOverrideSchema).max(100).default([]),
  })
  .superRefine((value, ctx) => {
    const products = new Set(value.productIds)
    const windows = new Set(value.windowIds)
    const assigned = new Set<string>()
    const targets = new Set<string>()
    if (
      products.size !== value.productIds.length ||
      windows.size !== value.windowIds.length
    )
      ctx.addIssue({ code: 'custom', message: '保存的商品和窗口不能重复' })
    for (const assignment of value.assignments) {
      if (!windows.has(assignment.windowId) || targets.has(assignment.windowId))
        ctx.addIssue({ code: 'custom', message: '分配必须属于当前窗口列表且不能重复' })
      targets.add(assignment.windowId)
      for (const id of assignment.productIds) {
        if (!products.has(id) || assigned.has(id))
          ctx.addIssue({ code: 'custom', message: '商品归属无效或重复' })
        assigned.add(id)
      }
      if (
        assignment.overrides.some(
          (override) => !assignment.productIds.includes(override.productId),
        ) ||
        new Set(assignment.overrides.map((item) => item.productId)).size !==
          assignment.overrides.length
      )
        ctx.addIssue({ code: 'custom', message: '编辑值必须属于当前分配商品' })
    }
    const unassigned = new Set<string>()
    for (const override of value.unassignedOverrides) {
      if (
        !products.has(override.productId) ||
        assigned.has(override.productId) ||
        unassigned.has(override.productId)
      )
        ctx.addIssue({ code: 'custom', message: '未分配商品的编辑值关系无效或重复' })
      unassigned.add(override.productId)
    }
    if (
      value.assignments.reduce(
        (total, assignment) => total + assignment.messages.length,
        0,
      ) > 100 ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength > 800 * 1024
    )
      ctx.addIssue({
        code: 'custom',
        message: '草稿最多保存 100 条消息且不能超过 800 KiB',
      })
  })
export const AgentWorkspaceSaveSchema = z.strictObject({
  id: uuid,
  kind: z.enum(['draft', 'template']),
  name: z.string().trim().min(1).max(120),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  data: AgentSavedPlanSchema,
})
export const AgentWorkspaceEntrySchema = AgentWorkspaceSaveSchema.omit({
  expectedRevision: true,
}).extend({
  revision: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
})
export const AgentWorkspacePageSchema = z.object({
  items: z.array(AgentWorkspaceEntrySchema.omit({ data: true })).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
})
export const AgentPreflightSchema = z.object({
  ready: z.boolean(),
  checkedAt: timestamp,
  checks: z
    .array(
      z.object({
        windowId: uuid.optional(),
        productId: uuid.optional(),
        code: z.string().max(100),
        severity: z.enum(['error', 'warning', 'ok']),
        message: z.string().max(1000),
        action: z.enum(['account', 'product', 'settings', 'window', 'none']),
      }),
    )
    .max(500),
})
export const AgentItemViewSchema = z.object({
  jobId: uuid,
  productId: uuid,
  windowId: uuid,
  windowName: z.string().max(200),
  accountId: uuid,
  state: z.string().max(100),
  reason: z.string().max(1000).default(''),
  originalTitle: z.string().max(500),
  originalDescription: z.string().max(6000),
  title: z.string().max(500),
  description: z.string().max(6000),
  artifactId: uuid.optional(),
  submitted: z.boolean(),
  controlRevision: z.number().int().nonnegative().default(0),
})
export const AgentItemPageSchema = z.object({
  items: z.array(AgentItemViewSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
})
export const AgentUsageSchema = z.object({
  batchId: uuid,
  requests: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  unknownUsage: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  maxRequests: z.number().int().positive(),
  maxCostUsd: z.number().positive().nullable(),
  notification: z.enum(['disabled', 'pending', 'sent', 'failed', 'none']),
})
export const AgentModelRequestSchema = z.strictObject({
  requestId: uuid,
  jobId: uuid,
  kind: z.enum(['decision', 'generation']),
  state: z.enum(['active', 'unknown', 'succeeded', 'failed', 'cancelled']),
  startedAt: timestamp,
  elapsedMs: z.number().int().min(0).max(120_000),
  inputTokens: z.number().int().min(0).max(100_000_000).nullable(),
  outputTokens: z.number().int().min(0).max(100_000_000).nullable(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  status: z.number().int().min(100).max(599).nullable(),
})
export const AgentModelRequestPageSchema = z.strictObject({
  batchId: uuid,
  items: z.array(AgentModelRequestSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
})
export const AgentRetentionPreviewSchema = z.object({
  before: timestamp,
  batches: z.number().int().nonnegative(),
  protected: z.number().int().nonnegative(),
  artifactBytes: z.number().int().nonnegative(),
  token: z.string().min(1).max(200),
})
export const AgentAttentionPageSchema = z.object({
  items: z
    .array(
      z.object({
        batchId: uuid,
        jobId: uuid,
        windowId: uuid,
        windowName: z.string().max(200),
        accountId: uuid,
        account: z.string().max(320),
        state: AgentJobStateSchema,
        phase: z.string().max(100),
        message: z.string().max(1000),
        currentProductId: uuid.optional(),
        updatedAt: timestamp,
      }),
    )
    .max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
})
export const AgentNotificationSchema = z.strictObject({
  notificationId: uuid,
  batchId: uuid,
  kind: z.enum(['completed', 'attention']),
  settings: AgentNotificationsSchema,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
})
export type AgentItemControl = z.infer<typeof AgentItemControlSchema>
export type AgentControls = z.infer<typeof AgentControlsSchema>
export type AgentSavedPlan = z.infer<typeof AgentSavedPlanSchema>
export type AgentWorkspaceSave = z.infer<typeof AgentWorkspaceSaveSchema>
export type AgentWorkspaceEntry = z.infer<typeof AgentWorkspaceEntrySchema>
export type AgentWorkspacePage = z.infer<typeof AgentWorkspacePageSchema>
export type AgentPreflight = z.infer<typeof AgentPreflightSchema>
export type AgentItemView = z.infer<typeof AgentItemViewSchema>
export type AgentItemPage = z.infer<typeof AgentItemPageSchema>
export type AgentUsage = z.infer<typeof AgentUsageSchema>
export type AgentModelRequest = z.infer<typeof AgentModelRequestSchema>
export type AgentModelRequestPage = z.infer<typeof AgentModelRequestPageSchema>
export type AgentRetentionPreview = z.infer<typeof AgentRetentionPreviewSchema>
export type AgentAttentionPage = z.infer<typeof AgentAttentionPageSchema>
export type AgentNotification = z.infer<typeof AgentNotificationSchema>
