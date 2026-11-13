import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import { z } from 'zod'
import {
  AgentControlsSchema,
  AgentProductOverrideSchema,
  AgentProductSnapshotSchema,
  AgentStepResultSchema,
  type AgentProductSnapshot,
  type AgentStepInput,
  type AgentStepResult,
} from '@nexus/plugin-sdk/agent'
import { AgentFailure, assertActive } from '../errors.js'
import type { AgentHost } from '../host.js'
import { HostCheckpointer } from './checkpointer.js'

export interface ReviewResult {
  decision: 'pass' | 'skip' | 'review'
  confidence: number
  reason: string
}
export interface Target {
  css?: string | undefined
  role?: string | undefined
  name?: string | undefined
  label?: string | undefined
  placeholder?: string | undefined
  testId?: string | undefined
  index?: number | undefined
}
export type BrowserPlan =
  | { action: 'fill' | 'select'; target: Target; value: string }
  | { action: 'click' | 'upload' | 'submit'; target: Target }
  | { action: 'done' | 'review'; reason: string }
export interface BrowserSnapshot {
  url: string
  title: string
  text: string
  controls: {
    index: number
    role: string
    name: string
    type?: string | undefined
    value?: string | undefined
  }[]
}
export interface Inspection {
  identity: { id: string; username: string }
  status: 'active' | 'pending' | 'limited' | 'blocked' | 'unknown'
  source: 'official' | 'page'
  balance?: { currency: string; available: string | null; pending: string | null }
  evidence: unknown
}
export interface BalanceInspection {
  balanceStatus: 'observed' | 'unavailable'
  balance?: { currency: string; available: string | null; pending: string | null }
  balanceSource?: 'official' | 'page'
  evidence: unknown
}
const ListingBaselineSchema = z.strictObject({
  url: z.string().url().max(4096),
  listingIds: z.array(z.string().regex(/^[1-9]\d{0,31}$/u)).max(200),
  observedAt: z.iso.datetime({ offset: true }),
})
const MessageBaselineSchema = z.strictObject({
  conversationId: z.string().regex(/^[1-9]\d{0,31}$/u),
  messageIds: z.array(z.string().regex(/^[1-9]\d{0,31}$/u)).max(200),
  observedAt: z.iso.datetime({ offset: true }),
})
type ListingContext = z.infer<typeof ListingBaselineSchema> & { intentStartedAt: string }
type MessageContext = z.infer<typeof MessageBaselineSchema> & { intentStartedAt: string }
export interface WorkflowPorts {
  inspectAccount(): Promise<Inspection>
  readBalance(): Promise<BalanceInspection>
  readAccountEvidence(): Promise<unknown>
  classifyAccount(input: {
    identity: unknown
    evidence: unknown
    signal?: AbortSignal
    requestId?: string
  }): Promise<{ tags: string[]; summary: string; rating?: number | undefined }>
  reviewImage(input: {
    product: AgentProductSnapshot
    image: { mime: string; data: string }
    signal?: AbortSignal
    requestId?: string
  }): Promise<ReviewResult>
  reviewCopy(input: {
    product: AgentProductSnapshot
    title: string
    description: string
    signal?: AbortSignal
    requestId?: string
  }): Promise<ReviewResult>
  rewriteCopy(input: {
    product: AgentProductSnapshot
    title: string
    description: string
    reason: string
    signal?: AbortSignal
    requestId?: string
  }): Promise<{ title: string; description: string }>
  plan(input: {
    goal: string
    snapshot: BrowserSnapshot
    product?: AgentProductSnapshot
    message?: { conversationId: string; text: string }
    signal?: AbortSignal
    requestId?: string
  }): Promise<BrowserPlan>
  openListing(): Promise<void>
  openConversation(id: string): Promise<void>
  snapshot(): Promise<BrowserSnapshot>
  executePlan(
    plan: BrowserPlan,
    product?: AgentProductSnapshot,
    operationId?: string,
  ): Promise<unknown>
  readListingForm(): Promise<{
    title: string
    description: string
    price: string | number
    currency: string
  }>
  readMessageForm(conversationId: string): Promise<{ text: string }>
  readListingBaseline(): Promise<z.infer<typeof ListingBaselineSchema>>
  readMessageBaseline(
    conversationId: string,
  ): Promise<z.infer<typeof MessageBaselineSchema>>
  confirmListing(
    product: AgentProductSnapshot,
    context: ListingContext,
  ): Promise<{
    listingId: string
    listingUrl: string
    publishedAt: string
  }>
  confirmMessage(
    conversationId: string,
    text: string,
    context: MessageContext,
  ): Promise<{
    messageId: string
    sentAt: string
  }>
}

const StateSchema = z.object({
  version: z.literal(1),
  planHash: z.string(),
  phase: z.enum([
    'inspect',
    'record_inspection',
    'read_balance',
    'record_balance',
    'read_evidence',
    'classify',
    'record_classification',
    'image_review',
    'copy_review',
    'rewrite',
    'open',
    'prepare',
    'capture_baseline',
    'submit',
    'confirm',
    'sync',
    'advance',
    'halt',
    'finished',
  ]),
  status: AgentStepResultSchema.shape.state,
  index: z.number().int().nonnegative(),
  imageIndex: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  rewrites: z.number().int().nonnegative(),
  title: z.string().max(500),
  description: z.string().max(6000),
  reason: z.string().max(1000),
  target: z.record(z.string(), z.unknown()).nullable(),
  inspection: z.unknown(),
  profileEvidence: z.unknown(),
  balanceObservation: z.unknown(),
  observedAt: z.string().max(64),
  listingBaseline: ListingBaselineSchema.nullable(),
  messageBaseline: MessageBaselineSchema.nullable(),
  intentStartedAt: z.string().max(64),
  classification: z.record(z.string(), z.unknown()).nullable(),
  confirmation: z.record(z.string(), z.unknown()).nullable(),
  published: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  retry: AgentStepResultSchema.shape.retry.unwrap().nullable().default(null),
  controlsRevision: z.number().int().nonnegative().default(0),
  appliedControls: z.record(z.string(), z.number().int().nonnegative()).default({}),
  amendments: z
    .record(z.string(), AgentProductOverrideSchema.omit({ productId: true }))
    .default({}),
  haltedPhase: z.string().max(100).default(''),
})
type WorkflowState = z.infer<typeof StateSchema>
const GraphState = Annotation.Root({ value: Annotation<WorkflowState>() })
const terminal = new Set<AgentStepResult['state']>(['completed', 'blocked', 'skipped'])
const ActionReceiptSchema = z.strictObject({
  state: z.enum(['missing', 'prepared', 'confirmed', 'unknown']),
  result: z.record(z.string(), z.unknown()).optional(),
})

export function operationIdFor(jobId: string, key: string): string {
  const bytes = createHash('sha256').update(`${jobId}\0${key}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function englishCopy(title: string, description: string): boolean {
  return (
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
      `${title}\n${description}`,
    )
  )
}

function checkReview(review: ReviewResult, threshold: number): ReviewResult {
  const parsed = z
    .strictObject({
      decision: z.enum(['pass', 'skip', 'review']),
      confidence: z.number().finite().min(0).max(1),
      reason: z.string().max(1000),
    })
    .parse(review)
  return parsed.confidence < threshold ? { ...parsed, decision: 'review' } : parsed
}

async function readImage(
  host: AgentHost,
  input: AgentStepInput,
  image: AgentProductSnapshot['images'][number],
  signal?: AbortSignal,
): Promise<string> {
  const chunks: Buffer[] = []
  let offset = 0
  while (offset < image.bytes) {
    assertActive(signal)
    const result = z
      .strictObject({
        data: z.string().max(262144),
        next: z.number().int().nonnegative(),
        done: z.boolean(),
        total: z.number().int().positive(),
      })
      .parse(
        await host.call(
          input.scope,
          'agent.artifact.read',
          {
            artifactId: image.artifactId,
            offset,
            length: 192 * 1024,
          },
          signal,
        ),
      )
    const chunk = Buffer.from(result.data, 'base64')
    if (
      chunk.toString('base64') !== result.data ||
      !chunk.length ||
      result.total !== image.bytes ||
      result.next !== offset + chunk.length ||
      result.next > image.bytes ||
      result.done !== (result.next === image.bytes)
    )
      throw new AgentFailure('PROTOCOL_ERROR', '商品图片分块校验失败')
    chunks.push(chunk)
    offset = result.next
  }
  const bytes = Buffer.concat(chunks)
  if (createHash('sha256').update(bytes).digest('hex') !== image.sha256)
    throw new AgentFailure('PROTOCOL_ERROR', '商品图片摘要校验失败')
  return bytes.toString('base64')
}

export async function runAgentStep(
  input: AgentStepInput,
  host: AgentHost,
  ports: WorkflowPorts,
  signal?: AbortSignal,
  now: () => Date = () => new Date(),
): Promise<AgentStepResult> {
  assertActive(signal)
  const { scope, snapshot, preset, settings } = input
  if (
    scope.windowId !== snapshot.windowId ||
    scope.accountId !== snapshot.account.accountId
  )
    throw new AgentFailure('PERMISSION_DENIED', '任务租约与窗口或账号不匹配')
  const planHash = createHash('sha256')
    .update(
      JSON.stringify({ snapshot, preset, instruction: input.instruction, settings }),
    )
    .digest('hex')
  const hostCall = <T = unknown>(method: string, payload: unknown) =>
    host.call<T>(scope, method, payload, signal)
  const pluginCall = (
    pluginId: string,
    capability: string,
    method: string,
    payload: unknown,
  ) => hostCall('agent.plugin.call', { pluginId, capability, method, payload })
  const observation = (
    suffix: string,
    observedAt: string,
    payload: Record<string, unknown>,
  ) =>
    pluginCall(
      'studio.vinted-accounts',
      'account.pool',
      'vinted.accounts.observations.record',
      {
        operationId: operationIdFor(scope.jobId, suffix),
        accountId: scope.accountId,
        windowId: scope.windowId,
        observedAt,
        ...payload,
      },
    )
  const inspect = async (): Promise<Inspection> => {
    const result = await ports.inspectAccount()
    if (result.identity.id !== snapshot.account.platformUserId)
      throw new AgentFailure(
        'IDENTITY_MISMATCH',
        '当前登录账号与窗口绑定不一致，已停止执行',
      )
    return result
  }
  let executedFrom: WorkflowState | undefined
  const execute = async (previous: WorkflowState): Promise<WorkflowState> => {
    assertActive(signal)
    let state = StateSchema.parse(previous)
    executedFrom = state
    if (state.planHash !== planHash)
      throw new AgentFailure('CONFLICT', '任务快照已变化，不能继续原执行流程')
    if (terminal.has(state.status)) return state
    const originalProduct = snapshot.products[state.index]
    const product = originalProduct
      ? AgentProductSnapshotSchema.parse({
          ...originalProduct,
          ...state.amendments[originalProduct.id],
        })
      : undefined
    const message = snapshot.messages[state.index]
    const activeProduct = product
      ? {
          ...product,
          title: state.title || product.title,
          description: state.description || product.description,
        }
      : undefined
    const operationId = operationIdFor(
      scope.jobId,
      preset === 'post_listing' ? `listing:${product?.id}` : `message:${state.index}`,
    )
    let commitMayExist = state.phase === 'confirm'
    let safeToRetry = new Set<WorkflowState['phase']>([
      'inspect',
      'read_balance',
      'read_evidence',
      'classify',
      'image_review',
      'copy_review',
      'rewrite',
      'capture_baseline',
      'prepare',
    ]).has(state.phase)
    const priorRetry = state.retry
    const requestId = operationIdFor(
      scope.jobId,
      [
        'model',
        state.index,
        state.phase,
        state.imageIndex,
        state.steps,
        state.rewrites,
        priorRetry?.attempt ?? 0,
        product ? (state.appliedControls[product.id] ?? 0) : 0,
      ].join(':'),
    )
    const halt = (reason: string): WorkflowState => ({
      ...state,
      phase: 'halt',
      status: 'review_required',
      reason: reason.slice(0, 1000),
      retry: null,
      haltedPhase: state.phase,
    })
    try {
      const controls = AgentControlsSchema.parse(await hostCall('agent.controls.get', {}))
      if (
        controls.revision < state.controlsRevision ||
        controls.items.some(
          (item) => !snapshot.products.some((entry) => entry.id === item.productId),
        )
      )
        return halt('商品控制修订或归属无效')
      state = { ...state, controlsRevision: controls.revision }
      const control = controls.items.find(
        (item) =>
          item.productId === product?.id &&
          item.revision > (state.appliedControls[item.productId] ?? 0),
      )
      const itemPhase = [
        'image_review',
        'copy_review',
        'rewrite',
        'open',
        'prepare',
        'capture_baseline',
        'submit',
      ].includes(state.phase === 'halt' ? state.haltedPhase : state.phase)
      if (product && control && itemPhase && snapshot.account.status !== 'blocked') {
        const receipt = ActionReceiptSchema.parse(
          await hostCall('agent.action.get', { operationId }),
        )
        if (receipt.state !== 'missing')
          return {
            ...state,
            phase: receipt.state === 'confirmed' ? 'sync' : 'confirm',
            status: receipt.state === 'confirmed' ? 'continue' : 'result_unknown',
            confirmation: receipt.result ?? state.confirmation,
            retry: null,
            reason: '已存在提交记录，仅允许核对结果',
          }
        state = {
          ...state,
          appliedControls: { ...state.appliedControls, [product.id]: control.revision },
          retry: null,
          status: 'continue',
          reason: '',
        }
        if (control.action === 'skip')
          return {
            ...state,
            phase: 'advance',
            skipped: state.skipped + 1,
            reason: '已按指令跳过商品',
          }
        const currentAmendment = state.amendments[product.id] ?? {}
        const amendment = { ...currentAmendment, ...control.override }
        // Native approval retains prior edits even when it adds no new amendment.
        if (
          control.action === 'revise' ||
          !isDeepStrictEqual(amendment, currentAmendment)
        ) {
          return {
            ...state,
            amendments: { ...state.amendments, [product.id]: amendment },
            phase: 'image_review',
            imageIndex: 0,
            steps: 0,
            rewrites: 0,
            title: '',
            description: '',
            target: null,
            listingBaseline: null,
            intentStartedAt: '',
            haltedPhase: '',
          }
        }
        if (state.phase === 'halt') {
          if (state.haltedPhase === 'image_review')
            return { ...state, phase: 'image_review', imageIndex: state.imageIndex + 1 }
          if (state.haltedPhase === 'copy_review' || state.haltedPhase === 'rewrite')
            return { ...state, phase: 'open' }
          return { ...state, phase: 'image_review', imageIndex: 0, steps: 0, rewrites: 0 }
        }
      }
      if (state.phase === 'halt') return state
      if (state.retry && Date.parse(state.retry.nextAttemptAt) > now().getTime())
        return state
      state = { ...state, retry: null }
      switch (state.phase) {
        case 'inspect': {
          if (snapshot.account.status === 'blocked')
            return {
              ...state,
              phase: 'finished',
              status: 'blocked',
              reason: '账号已封禁',
            }
          await hostCall('agent.browser.execute', {
            operation: 'navigate',
            origin: snapshot.platformOrigin,
            input: { url: `${snapshot.platformOrigin}/` },
            timeoutMs: 30_000,
          })
          const result = await inspect()
          return {
            ...state,
            phase: 'record_inspection',
            inspection: result,
            observedAt: now().toISOString(),
          }
        }
        case 'record_inspection': {
          const result = state.inspection as Inspection
          await observation('inspect', state.observedAt, {
            source: result.source,
            platformUserId: result.identity.id,
            ...(result.status === 'unknown' ? {} : { status: result.status }),
          })
          if (result.status === 'blocked')
            return {
              ...state,
              phase: 'finished',
              status: 'blocked',
              reason: '已确认账号封禁，后续操作已停止',
            }
          return { ...state, phase: 'read_balance' }
        }
        case 'read_balance': {
          const result = await ports.readBalance()
          return {
            ...state,
            balanceObservation: result,
            phase:
              result.balanceStatus === 'observed' ? 'record_balance' : 'read_evidence',
            observedAt: new Date(
              Math.max(now().getTime(), Date.parse(state.observedAt) + 1),
            ).toISOString(),
          }
        }
        case 'record_balance': {
          const result = state.balanceObservation as BalanceInspection
          if (!result.balance || !result.balanceSource)
            return halt('余额缺少可核实的金额或来源')
          await observation('balance', state.observedAt, {
            source: result.balanceSource,
            balance: result.balance,
          })
          return { ...state, phase: 'read_evidence' }
        }
        case 'read_evidence': {
          const evidence = await ports.readAccountEvidence()
          return { ...state, profileEvidence: evidence, phase: 'classify' }
        }
        case 'classify': {
          const inspection = state.inspection as Inspection
          const classified = await ports.classifyAccount({
            requestId,
            identity: inspection.identity,
            evidence: {
              account: inspection.evidence,
              profile: state.profileEvidence,
            },
            ...(signal ? { signal } : {}),
          })
          return {
            ...state,
            phase: 'record_classification',
            classification: classified,
            observedAt: new Date(
              Math.max(now().getTime(), Date.parse(state.observedAt) + 1),
            ).toISOString(),
          }
        }
        case 'record_classification':
          if (!state.classification) return halt('缺少已保存的账号分析结果')
          await observation('classification', state.observedAt, {
            source: 'model',
            ...state.classification,
          })
          return preset === 'inspect_accounts'
            ? {
                ...state,
                phase: 'finished',
                status: 'completed',
                reason:
                  (state.balanceObservation as BalanceInspection)?.balanceStatus ===
                  'observed'
                    ? '账号资料已更新'
                    : '账号资料已更新；本次余额未能读取，保留已有记录',
              }
            : { ...state, phase: preset === 'post_listing' ? 'image_review' : 'open' }
        case 'image_review': {
          if (!activeProduct) return halt('商品快照不存在')
          const image = activeProduct.images[state.imageIndex]
          if (!image) return { ...state, phase: 'copy_review' }
          const review = checkReview(
            await ports.reviewImage({
              requestId,
              product: activeProduct,
              image: {
                mime: image.mime,
                data: await readImage(host, input, image, signal),
              },
              ...(signal ? { signal } : {}),
            }),
            settings.reviewThreshold,
          )
          if (review.decision === 'review')
            return halt(`图片评估需要处理：${review.reason}`)
          if (review.decision === 'skip')
            return {
              ...state,
              phase: 'advance',
              skipped: state.skipped + 1,
              reason: review.reason,
            }
          return { ...state, imageIndex: state.imageIndex + 1 }
        }
        case 'copy_review': {
          if (!product || !activeProduct) return halt('商品快照不存在')
          if (!englishCopy(activeProduct.title, activeProduct.description))
            return {
              ...state,
              phase: 'rewrite',
              reason: 'Listing title and description must be English.',
            }
          const review = checkReview(
            await ports.reviewCopy({
              requestId,
              product,
              title: activeProduct.title,
              description: activeProduct.description,
              ...(signal ? { signal } : {}),
            }),
            settings.reviewThreshold,
          )
          if (review.decision === 'pass') return { ...state, phase: 'open' }
          if (review.decision === 'review')
            return halt(`文案评估需要处理：${review.reason}`)
          return { ...state, phase: 'rewrite', reason: review.reason }
        }
        case 'rewrite': {
          if (!product || !activeProduct) return halt('商品快照不存在')
          if (state.rewrites >= settings.maxCopyRewrites)
            return halt('文案改写后仍未通过检查，请修改商品资料后重新创建任务')
          const copy = await ports.rewriteCopy({
            requestId,
            product,
            title: activeProduct.title,
            description: activeProduct.description,
            reason: state.reason,
            ...(signal ? { signal } : {}),
          })
          if (!englishCopy(copy.title, copy.description))
            return halt('模型未返回英文商品文案')
          return { ...state, ...copy, rewrites: state.rewrites + 1, phase: 'copy_review' }
        }
        case 'open':
          if (preset === 'post_listing') await ports.openListing()
          else if (message) await ports.openConversation(message.conversationId)
          else return halt('请指定会话和消息内容')
          return { ...state, phase: 'prepare', steps: 0 }
        case 'prepare': {
          if (state.steps >= settings.maxStepsPerItem)
            return halt('已达到单件任务的浏览器步骤上限')
          const page = await ports.snapshot()
          const plan = await ports.plan({
            requestId,
            goal:
              preset === 'post_listing'
                ? `Prepare the exact assigned second-hand listing. ${input.instruction}`
                : `Prepare this exact message in the assigned conversation. ${input.instruction}`,
            snapshot: page,
            ...(activeProduct ? { product: activeProduct } : {}),
            ...(message ? { message } : {}),
            ...(signal ? { signal } : {}),
          })
          if (plan.action === 'review' || plan.action === 'done')
            return halt(plan.reason || '尚未取得明确的提交按钮')
          if (plan.action === 'submit')
            return { ...state, target: { ...plan.target }, phase: 'capture_baseline' }
          safeToRetry = false
          await ports.executePlan(plan, activeProduct)
          return { ...state, steps: state.steps + 1 }
        }
        case 'capture_baseline': {
          const listingBaseline = activeProduct
            ? ListingBaselineSchema.parse(await ports.readListingBaseline())
            : null
          const messageBaseline = message
            ? MessageBaselineSchema.parse(
                await ports.readMessageBaseline(message.conversationId),
              )
            : null
          const baseline = listingBaseline ?? messageBaseline
          if (!baseline) return halt('缺少提交前的核对基线')
          return {
            ...state,
            listingBaseline,
            messageBaseline,
            phase: 'submit',
            intentStartedAt: new Date(
              Math.max(now().getTime(), Date.parse(baseline.observedAt)),
            ).toISOString(),
          }
        }
        case 'submit': {
          // A previous invocation may have committed before its checkpoint was saved.
          commitMayExist = true
          const existing = ActionReceiptSchema.parse(
            await hostCall('agent.action.get', { operationId }),
          )
          if (existing.state === 'confirmed')
            return { ...state, phase: 'sync', confirmation: existing.result ?? null }
          if (existing.state !== 'missing')
            return {
              ...state,
              phase: 'confirm',
              status: 'result_unknown',
              reason: '提交意图已存在，先核对平台结果',
            }
          commitMayExist = false
          safeToRetry = true
          const result = await inspect()
          if (result.status === 'blocked') {
            const blockedAt = now().toISOString()
            await observation(`blocked:${state.index}:${blockedAt}`, blockedAt, {
              source: result.source,
              status: 'blocked',
              platformUserId: result.identity.id,
            })
            return {
              ...state,
              phase: 'finished',
              status: 'blocked',
              reason: '提交前确认账号封禁，已停止',
            }
          }
          if (!state.target) return halt('缺少经过校验的提交目标')
          if (activeProduct) {
            const form = await ports.readListingForm()
            const price =
              typeof form.price === 'number'
                ? form.price
                : Number(form.price.replace(',', '.').trim())
            if (
              form.title.trim() !== activeProduct.title.trim() ||
              form.description.trim() !== activeProduct.description.trim() ||
              !Number.isFinite(price) ||
              Math.abs(price - activeProduct.price) > 0.000001 ||
              form.currency !== activeProduct.currency
            )
              return halt('平台表单与确认的商品标题、描述、价格或币种不一致')
          } else if (message) {
            const form = await ports.readMessageForm(message.conversationId)
            if (form.text !== message.text) return halt('平台消息与指定的英文消息不一致')
          } else {
            return halt('缺少本次提交内容')
          }
          if (!state.intentStartedAt || !(state.listingBaseline ?? state.messageBaseline))
            return halt('缺少已保存的提交前核对基线')
          commitMayExist = true
          safeToRetry = false
          const receipt = await hostCall<{
            state: 'prepared' | 'confirmed' | 'unknown'
            fresh: boolean
            result?: Record<string, unknown>
          }>('agent.action.prepare', {
            operationId,
            kind: preset === 'post_listing' ? 'listing' : 'message',
            digest: createHash('sha256')
              .update(
                JSON.stringify({
                  product: activeProduct,
                  message,
                }),
              )
              .digest('hex'),
          })
          if (receipt.state === 'confirmed')
            return { ...state, phase: 'sync', confirmation: receipt.result ?? null }
          if (receipt.state !== 'prepared' || !receipt.fresh)
            return {
              ...state,
              phase: 'confirm',
              status: 'result_unknown',
              reason: '提交意图已存在，先核对平台结果',
            }
          await ports.executePlan(
            { action: 'submit', target: state.target as Target },
            activeProduct,
            operationId,
          )
          return { ...state, phase: 'confirm' }
        }
        case 'confirm': {
          const receipt = ActionReceiptSchema.parse(
            await hostCall('agent.action.get', { operationId }),
          )
          if (receipt.state === 'confirmed')
            return {
              ...state,
              phase: 'sync',
              confirmation: receipt.result ?? null,
              status: 'continue',
              reason: '',
            }
          if (receipt.state === 'missing')
            return {
              ...state,
              status: 'result_unknown',
              reason: '提交记录暂不可用，请核对后继续',
            }
          let confirmation: Record<string, unknown>
          if (activeProduct) {
            if (!state.listingBaseline) return halt('缺少发布前的核对基线')
            confirmation = {
              kind: 'listing',
              productId: activeProduct.id,
              productRevision: activeProduct.revision,
              ...(await ports.confirmListing(activeProduct, {
                ...state.listingBaseline,
                intentStartedAt: state.intentStartedAt,
              })),
              windowId: snapshot.windowId,
              windowName: snapshot.windowName,
              platform: 'vinted',
            }
          } else if (message) {
            if (!state.messageBaseline) return halt('缺少发信前的核对基线')
            const evidence = z
              .strictObject({
                messageId: z.string().regex(/^[1-9]\d{0,31}$/u),
                sentAt: z.iso.datetime({ offset: true }),
              })
              .parse(
                await ports.confirmMessage(message.conversationId, message.text, {
                  ...state.messageBaseline,
                  intentStartedAt: state.intentStartedAt,
                }),
              )
            confirmation = {
              kind: 'message',
              conversationId: message.conversationId,
              text: message.text,
              confirmedAt: now().toISOString(),
              evidence,
            }
          } else return halt('提交结果没有对应的任务条目')
          await hostCall('agent.action.confirm', { operationId, result: confirmation })
          return { ...state, confirmation, phase: 'sync', status: 'continue', reason: '' }
        }
        case 'sync':
          if (activeProduct) {
            if (!state.confirmation) return halt('缺少已确认的发布事实')
            const result = state.confirmation
            await pluginCall(
              'studio.products',
              'product.catalog',
              'products.publications.record',
              {
                productId: activeProduct.id,
                productRevision: activeProduct.revision,
                operationId,
                windowId: snapshot.windowId,
                windowName: snapshot.windowName,
                platform: 'vinted',
                listingId: result['listingId'],
                listingUrl: result['listingUrl'],
                publishedAt: result['publishedAt'],
              },
            )
          }
          return {
            ...state,
            phase: 'advance',
            status: 'continue',
            published: state.published + 1,
          }
        case 'advance': {
          const next = state.index + 1
          const total =
            preset === 'post_listing'
              ? snapshot.products.length
              : snapshot.messages.length
          if (next >= total)
            return {
              ...state,
              phase: 'finished',
              status: state.published ? 'completed' : 'skipped',
              reason: `已完成 ${state.published} 项，跳过 ${state.skipped} 项`,
            }
          const amendments = { ...state.amendments }
          if (product) delete amendments[product.id]
          return {
            ...state,
            amendments,
            index: next,
            imageIndex: 0,
            steps: 0,
            rewrites: 0,
            title: '',
            description: '',
            target: null,
            confirmation: null,
            reason: '',
            listingBaseline: null,
            messageBaseline: null,
            intentStartedAt: '',
            phase: preset === 'post_listing' ? 'image_review' : 'open',
            status: 'continue',
          }
        }
        default:
          return halt('工作流阶段无法继续')
      }
    } catch (error) {
      if (signal?.aborted) throw error
      if (commitMayExist) {
        await hostCall('agent.action.unknown', { operationId }).catch(() => {})
        return {
          ...state,
          phase: 'confirm',
          status: 'result_unknown',
          reason: '提交结果暂未确认，请核对平台结果；不会重复提交',
        }
      }
      if (state.phase === 'sync')
        return {
          ...state,
          status: 'sync_pending',
          reason: '平台操作已确认，等待同步发布记录',
        }
      if (safeToRetry && error instanceof AgentFailure && error.retryable) {
        const attempt = (priorRetry?.attempt ?? 0) + 1
        if (attempt <= settings.execution.maxReadRetries) {
          const hints = z
            .object({
              retryAfterMs: z.number().finite().min(0).optional(),
              status: z.number().int().optional(),
            })
            .parse(error)
          const delay = Math.min(
            300_000,
            Math.max(
              settings.execution.retryBaseMs * 2 ** (attempt - 1),
              hints.retryAfterMs ?? 0,
              hints.status === 429 ? settings.execution.platformCooldownMs : 0,
            ),
          )
          return {
            ...state,
            status: 'continue',
            reason: error.message.slice(0, 1000),
            retry: {
              attempt,
              maxAttempts: settings.execution.maxReadRetries,
              nextAttemptAt: new Date(now().getTime() + delay).toISOString(),
              code: error.code.slice(0, 100),
            },
          }
        }
      }
      return halt(
        error instanceof AgentFailure
          ? error.message
          : '当前步骤无法确认，请检查任务资料和服务配置',
      )
    }
  }
  const saver = new HostCheckpointer(host, scope, signal)
  const graph = new StateGraph(GraphState)
    .addNode('step', async ({ value }) => ({ value: await execute(value) }))
    .addEdge(START, 'step')
    .addConditionalEdges('step', ({ value }) =>
      terminal.has(value.status) ? END : 'step',
    )
    .compile({ checkpointer: saver, interruptAfter: ['step'] })
  const config = {
    configurable: { thread_id: scope.jobId, checkpoint_ns: '' },
    ...(signal ? { signal } : {}),
    recursionLimit: 5,
    durability: 'sync' as const,
  }
  const existing = await saver.getTuple(config)
  const initial: WorkflowState = {
    version: 1,
    planHash,
    phase: 'inspect',
    status: 'continue',
    index: 0,
    imageIndex: 0,
    steps: 0,
    rewrites: 0,
    title: '',
    description: '',
    reason: '',
    target: null,
    inspection: null,
    observedAt: '',
    profileEvidence: null,
    balanceObservation: null,
    listingBaseline: null,
    messageBaseline: null,
    intentStartedAt: '',
    classification: null,
    confirmation: null,
    published: 0,
    skipped: 0,
    retry: null,
    controlsRevision: 0,
    appliedControls: {},
    amendments: {},
    haltedPhase: '',
  }
  const output = await graph.invoke(existing ? null : { value: initial }, config)
  const state = StateSchema.parse(output.value)
  const product = snapshot.products[state.index]
  const itemState = (): NonNullable<AgentStepResult['itemUpdates']>[number]['state'] => {
    if (
      state.status === 'review_required' ||
      state.status === 'result_unknown' ||
      state.status === 'sync_pending'
    )
      return state.status
    if (state.phase === 'advance' || state.phase === 'finished')
      return state.confirmation ? 'published' : 'skipped'
    if (state.phase === 'confirm') return 'submitting'
    if (['image_review', 'copy_review', 'rewrite'].includes(state.phase))
      return 'reviewing'
    if (['open', 'prepare', 'capture_baseline', 'submit'].includes(state.phase))
      return 'preparing'
    if (state.phase === 'sync') return 'sync_pending'
    return 'pending'
  }
  const itemUpdates: NonNullable<AgentStepResult['itemUpdates']> = []
  if (product)
    itemUpdates.push({
      productId: product.id,
      state: itemState(),
      reason: state.reason,
      title: state.title || state.amendments[product.id]?.title || product.title,
      description:
        state.description ||
        state.amendments[product.id]?.description ||
        product.description,
    })
  if (executedFrom && executedFrom.index !== state.index) {
    const previous = snapshot.products[executedFrom.index]
    if (previous)
      itemUpdates.unshift({
        productId: previous.id,
        state: executedFrom.confirmation ? 'published' : 'skipped',
        reason: executedFrom.reason,
      })
  }
  return AgentStepResultSchema.parse({
    state: state.status,
    phase: state.phase,
    message: state.reason,
    ...(state.retry ? { retry: state.retry } : {}),
    progress: {
      currentIndex: state.index,
      published: state.published,
      skipped: state.skipped,
      ...(product ? { currentProductId: product.id } : {}),
    },
    ...(itemUpdates.length ? { itemUpdates } : {}),
  })
}
