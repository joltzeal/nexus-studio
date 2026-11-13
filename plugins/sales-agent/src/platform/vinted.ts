import { z } from 'zod'
import type { AgentProductSnapshot } from '@nexus/plugin-sdk/agent'
import { AgentFailure } from '../errors.js'
import {
  BrowserPlanSchema,
  BrowserSnapshotSchema,
  contextJson,
  redactText,
  type BrowserPlan,
  type BrowserSnapshot,
  type Target,
} from '../services/validation.js'
import {
  currencyEvidence,
  formLabel,
  hasLabel,
  observedBalance,
  type Balance,
} from './vinted-evidence.js'
import { sellerFeedback, sellerItems, sellerProfile } from './vinted-account-evidence.js'

type AccountStatus = 'active' | 'pending' | 'limited' | 'blocked' | 'unknown'
type BrowserRequest = {
  operation: string
  origin: string
  input: unknown
  timeoutMs?: number
}
export interface VintedAccountObservation {
  identity: { id: string; username: string }
  status: AccountStatus
  source: 'official' | 'page'
  balance?: Balance
  balanceSource?: 'official' | 'page'
  balanceStatus: 'observed' | 'unavailable'
  evidence: unknown
}
export interface ObservedListingForm {
  title: string
  description: string
  price: string
  currency: string
}
export interface BalanceObservation {
  balanceStatus: 'observed' | 'unavailable'
  balance?: Balance
  balanceSource?: 'page'
  evidence: unknown
}
export interface AccountEvidenceObservation {
  evidenceStatus: 'observed' | 'unavailable'
  evidence: Record<string, unknown>
}
export interface ListingBaseline {
  url: string
  listingIds: string[]
  observedAt: string
}
export interface MessageBaseline {
  conversationId: string
  messageIds: string[]
  observedAt: string
}
export type ListingConfirmationContext = ListingBaseline & { intentStartedAt: string }
export type MessageConfirmationContext = MessageBaseline & { intentStartedAt: string }

export class VintedToolError extends AgentFailure {
  constructor(
    override readonly code:
      | 'REVIEW_REQUIRED'
      | 'RESULT_UNKNOWN'
      | 'INVALID_REQUEST'
      | 'PLATFORM_NETWORK'
      | 'PLATFORM_HTTP',
    message: string,
    readonly evidence?: unknown,
    retryable = false,
    readonly status?: number,
  ) {
    super(code, `${code}: ${message}`, retryable)
    this.name = 'VintedToolError'
  }
}

const MAX_EVIDENCE_BYTES = 256 * 1024
const apiEnvelope = z.strictObject({
  url: z.string().url().max(4096),
  status: z.number().int().min(100).max(599),
  text: z.string().max(65_536),
})
const statuses = new Set<AccountStatus>(['active', 'pending', 'limited', 'blocked'])
const baselineTimestamp = z.iso.datetime({ offset: true }).max(64)
const baselineListingIds = z
  .array(z.string().regex(/^[1-9]\d{0,31}$/u))
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length)
const listingConfirmation = z.strictObject({
  url: z.string().url().max(4096),
  listingIds: baselineListingIds,
  observedAt: baselineTimestamp,
  intentStartedAt: baselineTimestamp,
})
const messageConfirmation = z.strictObject({
  conversationId: z.string().regex(/^[1-9]\d{0,31}$/u),
  messageIds: z.array(z.string().regex(/^[1-9]\d{0,31}$/u)).max(200),
  observedAt: baselineTimestamp,
  intentStartedAt: baselineTimestamp,
})

function intentTime(baseline: { observedAt: string; intentStartedAt: string }): number {
  const observed = observedTimestamp(baseline.observedAt)
  const intent = observedTimestamp(baseline.intentStartedAt)
  if (!observed || !intent || Date.parse(observed) > Date.parse(intent)) unknownResult()
  return Date.parse(intent)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function numericId(value: unknown): string | undefined {
  const text =
    typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === 'string'
        ? value
        : ''
  return /^\d{1,32}$/u.test(text) && BigInt(text) > 0
    ? BigInt(text).toString()
    : undefined
}

function unknownResult(): never {
  throw new VintedToolError(
    'RESULT_UNKNOWN',
    'The external result could not be confirmed. Do not repeat the submission.',
  )
}

function review(
  message = 'Observed platform evidence is insufficient for a safe operation.',
): never {
  throw new VintedToolError('REVIEW_REQUIRED', message)
}

function safeUrl(raw: string, origin: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return review()
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    /[\s\\]/u.test(raw) ||
    [...raw].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    review()
  return url
}

function listingId(raw: string, origin: string): string {
  const url = safeUrl(raw, origin)
  if (url.search || url.hash) unknownResult()
  const match = /^\/items\/([1-9]\d{0,31})(?:-[^/]+)?\/?$/u.exec(url.pathname)
  if (!match?.[1]) unknownResult()
  return match[1]
}

function observedTimestamp(value: unknown): string | undefined {
  let time: number
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value))
    time = Date.parse(value)
  else if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    time = value < 100_000_000_000 ? value * 1000 : value
  } else return undefined
  if (!Number.isFinite(time) || time < 0 || time > Date.now() + 5 * 60_000)
    return undefined
  return new Date(time).toISOString()
}

function actionTimestamp(value: unknown, intentStartedAt: number): string | undefined {
  const timestamp = observedTimestamp(value)
  if (!timestamp) return undefined
  let resolutionMs = 1
  if (typeof value === 'string') {
    const match = /T\d{2}:\d{2}:\d{2}(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value)
    if (!match) return undefined
    resolutionMs = 10 ** (3 - Math.min(3, match[1]?.length ?? 0))
  } else if (typeof value === 'number' && value < 100_000_000_000) {
    const fractionDigits = String(value).split('.')[1]?.length ?? 0
    resolutionMs = 10 ** (3 - Math.min(3, fractionDigits))
  }
  // Compare within the precision actually reported by the API; baseline IDs
  // independently exclude previously observed listings and messages.
  return Date.parse(timestamp) >=
    Math.floor(intentStartedAt / resolutionMs) * resolutionMs &&
    Date.parse(timestamp) <= intentStartedAt + 5 * 60_000
    ? timestamp
    : undefined
}

function pageStatus(snapshot: BrowserSnapshot): AccountStatus {
  // Only direct, account-specific notices count. Public profiles and generic
  // forbidden/challenge pages do not establish an account restriction.
  const text = snapshot.text
  if (
    !/^\/(?:settings|account|blocked|banned|restricted)(?:\/|$)/u.test(
      new URL(snapshot.url).pathname,
    )
  ) {
    return 'unknown'
  }
  if (
    /^\s*your account (?:has been |is )(?:permanently )?(?:blocked|banned)[.!]?\s*$/imu.test(
      text,
    )
  )
    return 'blocked'
  if (
    /^\s*your account (?:has been |is )(?:temporarily )?(?:limited|restricted)[.!]?\s*$/imu.test(
      text,
    )
  )
    return 'limited'
  if (
    /^\s*your account (?:is |has )?(?:pending verification|verification pending)[.!]?\s*$/imu.test(
      text,
    )
  )
    return 'pending'
  return 'unknown'
}

export class VintedTools {
  private readonly origin: string
  private readonly expectedUserId: string

  constructor(
    private readonly execute: (request: BrowserRequest) => Promise<unknown>,
    origin: string,
    expectedUserId: string,
  ) {
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      throw new VintedToolError('INVALID_REQUEST', 'Invalid platform origin.')
    }
    if (
      url.protocol !== 'https:' ||
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.port ||
      !/^www\.vinted\.(?:com|co\.uk|fr|de|it|es|nl|be|at|pl|pt|cz|sk|lt|lu|se|dk|fi|hr|hu|ro|gr|ie)$/u.test(
        url.hostname,
      )
    ) {
      throw new VintedToolError('INVALID_REQUEST', 'Invalid platform origin.')
    }
    const id = numericId(expectedUserId)
    if (!id)
      throw new VintedToolError(
        'INVALID_REQUEST',
        'A bound platform user ID is required.',
      )
    this.origin = origin
    this.expectedUserId = id
  }

  private async call(
    operation: string,
    input: unknown,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    try {
      return await this.execute({
        operation,
        origin: this.origin,
        input,
        timeoutMs,
      })
    } catch (error) {
      if (operation === 'submit') unknownResult()
      if (
        ['request', 'snapshot', 'readFields'].includes(operation) &&
        error instanceof AgentFailure &&
        error.retryable
      )
        throw new VintedToolError(
          'PLATFORM_NETWORK',
          'A read-only browser request is temporarily unavailable.',
          undefined,
          true,
        )
      return review('The browser operation failed; platform evidence must be reviewed.')
    }
  }

  private async get(path: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const raw = await this.call('request', { method: 'GET', path }, timeoutMs)
    let bytes: number
    try {
      bytes = Buffer.byteLength(JSON.stringify(raw))
    } catch {
      return review()
    }
    if (bytes > MAX_EVIDENCE_BYTES)
      review('The platform response exceeds the evidence byte limit.')
    const envelope = apiEnvelope.safeParse(raw)
    if (!envelope.success) review()
    const url = safeUrl(envelope.data.url, this.origin)
    const expectedUrl = new URL(path, this.origin)
    if (
      url.pathname !== expectedUrl.pathname ||
      url.search !== expectedUrl.search ||
      url.hash ||
      Buffer.byteLength(envelope.data.text) > 65_536
    )
      review()
    if (envelope.data.status === 429 || envelope.data.status >= 500)
      throw new VintedToolError(
        'PLATFORM_HTTP',
        'The platform read is temporarily unavailable.',
        undefined,
        true,
        envelope.data.status,
      )
    if (envelope.data.status !== 200) review()
    let body: Record<string, unknown> | undefined
    try {
      body = object(JSON.parse(envelope.data.text))
    } catch {
      return review()
    }
    if (!body || (body.code !== undefined && body.code !== 0)) review()
    return body
  }

  async inspectAccount(): Promise<VintedAccountObservation> {
    let body: Record<string, unknown>
    try {
      body = await this.get('/api/v2/users/current')
    } catch (error) {
      if (error instanceof AgentFailure && error.retryable) throw error
      // UI evidence can explain why authentication is unavailable; it cannot
      // replace an authenticated current-user identity.
      let evidence: unknown = { authenticatedIdentity: 'unavailable' }
      try {
        const snapshot = await this.snapshot()
        evidence = { authenticatedIdentity: 'unavailable', page: snapshot }
      } catch {
        /* Keep the bounded unavailable observation. */
      }
      throw new VintedToolError(
        'REVIEW_REQUIRED',
        'Authenticated current-user identity is unavailable.',
        evidence,
      )
    }
    const user = object(body.user)
    const id = numericId(user?.id)
    const username = user?.login ?? user?.username
    if (
      !user ||
      !id ||
      id !== this.expectedUserId ||
      typeof username !== 'string' ||
      !username.trim() ||
      username.length > 200 ||
      /[\s@]/u.test(username) ||
      (user.login !== undefined &&
        user.username !== undefined &&
        user.login !== user.username) ||
      (user.user_id !== undefined && numericId(user.user_id) !== id)
    ) {
      review(
        'Authenticated identity is missing, ambiguous, or differs from the bound account.',
      )
    }
    const identity = { id, username }
    const official: AccountStatus =
      user.is_blocked === true || user.is_banned === true
        ? 'blocked'
        : typeof user.status === 'string' && statuses.has(user.status as AccountStatus)
          ? (user.status as AccountStatus)
          : 'unknown'
    const evidence: Record<string, unknown> = {
      endpoint: '/api/v2/users/current',
      identity,
      officialStatus: official,
      observedAt: new Date().toISOString(),
    }
    if (official !== 'unknown')
      return {
        identity,
        status: official,
        source: 'official',
        balanceStatus: 'unavailable',
        evidence,
      }
    try {
      const snapshot = await this.snapshot()
      evidence.page = {
        url: snapshot.url,
        title: snapshot.title,
        text: snapshot.text.slice(0, 8000),
      }
      return {
        identity,
        status: pageStatus(snapshot),
        source: 'page',
        balanceStatus: 'unavailable',
        evidence,
      }
    } catch {
      return {
        identity,
        status: official,
        source: 'official',
        balanceStatus: 'unavailable',
        evidence,
      }
    }
  }

  async readBalance(): Promise<BalanceObservation> {
    const unavailable = (reason: string): BalanceObservation => ({
      balanceStatus: 'unavailable',
      evidence: { source: 'page', reason, observedAt: new Date().toISOString() },
    })
    try {
      const account = await this.inspectAccount()
      if (account.status === 'blocked') return unavailable('account_blocked')
      let page = await this.snapshot()
      // This optional check is separate from identity rechecks. Never leave a
      // prepared listing or conversation to look for a wallet.
      if (/^\/(?:items\/new|inbox)(?:\/|$)/u.test(new URL(page.url).pathname)) {
        return unavailable('prepared_page_open')
      }
      let balance = observedBalance(page)
      if (!balance) {
        const links = page.controls.filter(
          (control) => control.role === 'link' && hasLabel('wallet', control.name),
        )
        if (links.length !== 1) return unavailable('wallet_link_unavailable')
        const result = await this.call('click', { target: { index: links[0]!.index } })
        if (object(result)?.completed !== true)
          return unavailable('wallet_navigation_unconfirmed')
        page = await this.snapshot()
        balance = observedBalance(page)
      }
      if (!balance) return unavailable('balance_fields_unavailable')
      return {
        balanceStatus: 'observed',
        balance,
        balanceSource: 'page',
        evidence: { source: 'page', url: page.url, observedAt: new Date().toISOString() },
      }
    } catch (error) {
      if (error instanceof AgentFailure && error.retryable) throw error
      return unavailable('balance_read_failed')
    }
  }

  async readAccountEvidence(): Promise<AccountEvidenceObservation> {
    const account = await this.inspectAccount()
    const evidence: Record<string, unknown> = {
      source: 'official',
      identity: account.identity,
      accountStatus: account.status,
      observedAt: new Date().toISOString(),
      sample: true,
    }
    const availability = {
      profile: 'unavailable',
      items: 'unavailable',
      feedback: 'unavailable',
    }
    if (account.status === 'blocked') {
      return { evidenceStatus: 'unavailable', evidence: { ...evidence, availability } }
    }
    // Read-only sources: nexus-cart vinted_scraper.py get_user /
    // iter_user_feedback; vinted-accounts order-source.ts scan uses wardrobe.
    const read = async (path: string) =>
      this.get(path).catch((error: unknown) => {
        if (error instanceof AgentFailure && error.retryable) throw error
        return undefined
      })
    // Each account has one browser actor; overlapping reads are rejected by its lock.
    const profileResponse = await read(`/api/v2/users/${this.expectedUserId}`)
    const itemsResponse = await read(
      `/api/v2/wardrobe/${this.expectedUserId}/items?page=1&per_page=12&order=newest_first`,
    )
    const feedbackResponse = await read(
      `/api/v2/user_feedbacks?user_id=${this.expectedUserId}&by=all&page=1&per_page=12`,
    )
    const profile =
      profileResponse !== undefined
        ? sellerProfile(profileResponse, account.identity)
        : undefined
    const items =
      itemsResponse !== undefined
        ? sellerItems(itemsResponse, this.expectedUserId)
        : undefined
    const feedback =
      feedbackResponse !== undefined
        ? sellerFeedback(feedbackResponse, this.expectedUserId)
        : undefined
    if (profile) {
      availability.profile = 'observed'
      evidence.profile = profile
      if (typeof profile.rating === 'number') evidence.rating = profile.rating
    }
    if (items) {
      availability.items = 'observed'
      evidence.items = items
    }
    if (feedback) {
      availability.feedback = 'observed'
      evidence.feedback = feedback
    }
    evidence.availability = availability
    return {
      evidenceStatus: Object.values(availability).includes('observed')
        ? 'observed'
        : 'unavailable',
      evidence,
    }
  }

  async snapshot(timeoutMs = 30_000): Promise<BrowserSnapshot> {
    const raw = await this.call('snapshot', { maxChars: 20_000 }, timeoutMs)
    const rawUrl = object(raw)?.url
    if (typeof rawUrl !== 'string') review()
    const url = safeUrl(rawUrl, this.origin)
    if (url.search || url.hash)
      review('Page URL parameters require review before using the evidence.')
    let safe: unknown
    try {
      const text = contextJson(raw)
      if (Buffer.byteLength(text) > MAX_EVIDENCE_BYTES)
        review('Page evidence exceeds the byte limit.')
      safe = JSON.parse(text)
    } catch {
      return review('Page evidence exceeds the limit or has an invalid format.')
    }
    const parsed = BrowserSnapshotSchema.safeParse(safe)
    if (!parsed.success)
      review('Page evidence exceeds the limit or has an invalid format.')
    const snapshot = parsed.data
    const secrets = snapshot.controls
      .filter(
        (control) =>
          control.type === 'password' ||
          /password|token|secret|cookie|authorization/iu.test(control.name),
      )
      .flatMap((control) => (control.value ? [control.value] : []))
    return {
      ...snapshot,
      url: `${url.origin}${url.pathname}`,
      title: redactText(snapshot.title, secrets),
      text: redactText(snapshot.text, secrets),
      controls: snapshot.controls.map((control) =>
        control.type === 'password' ||
        /password|token|secret|cookie|authorization/iu.test(control.name)
          ? { ...control, value: '[REDACTED]' }
          : {
              ...control,
              name: redactText(control.name, secrets),
              ...(control.value !== undefined
                ? { value: redactText(control.value, secrets) }
                : {}),
            },
      ),
    }
  }

  private async navigate(path: string): Promise<void> {
    const raw = await this.call('navigate', { url: `${this.origin}${path}` })
    const url = object(raw)?.url
    if (typeof url !== 'string' || safeUrl(url, this.origin).pathname !== path)
      review('The intended platform page was not reached.')
  }

  async openListing(): Promise<void> {
    await this.navigate('/items/new')
  }

  async openConversation(id: string): Promise<void> {
    if (!numericId(id) || numericId(id) !== id)
      throw new VintedToolError('INVALID_REQUEST', 'Invalid conversation ID.')
    await this.navigate(`/inbox/${id}`)
  }

  private async validateSubmitTarget(target: Target, listing: boolean): Promise<void> {
    const snapshot = await this.snapshot()
    const path = new URL(snapshot.url).pathname
    if (listing ? path !== '/items/new' : !/^\/inbox\/[1-9]\d{0,31}$/u.test(path)) {
      review('The final action is not on the assigned platform form.')
    }
    if (
      target.css ||
      target.label ||
      target.placeholder ||
      target.testId ||
      (target.index === undefined && (!target.role || !target.name))
    ) {
      review('The final action target cannot be verified from observed controls.')
    }
    const matches = snapshot.controls.filter(
      (control) =>
        (target.index === undefined || target.index === control.index) &&
        (target.role === undefined || target.role === control.role) &&
        (target.name === undefined || target.name === control.name),
    )
    const control = matches[0]
    if (
      matches.length !== 1 ||
      !control ||
      control.role !== 'button' ||
      !['', 'button', 'submit'].includes(control.type ?? '') ||
      !hasLabel(listing ? 'publish' : 'send', control.name)
    ) {
      review('The observed target is not a recognized final publish or send action.')
    }
  }

  async executePlan(
    plan: BrowserPlan,
    product?: AgentProductSnapshot,
    operationId?: string,
  ): Promise<void> {
    const parsed = BrowserPlanSchema.safeParse(plan)
    if (!parsed.success)
      throw new VintedToolError('INVALID_REQUEST', 'Invalid browser plan.')
    plan = parsed.data
    if (plan.action === 'done' || plan.action === 'review') return
    if (plan.action === 'submit') {
      if (!z.uuid().safeParse(operationId).success) {
        throw new VintedToolError(
          'INVALID_REQUEST',
          'Submit requires the persisted intent operation ID.',
        )
      }
      await this.validateSubmitTarget(plan.target, product !== undefined)
      const result = await this.call('submit', { target: plan.target, operationId })
      if (object(result)?.completed !== true) unknownResult()
      return
    }
    if (plan.action === 'upload') {
      const ids = z
        .array(z.uuid())
        .min(1)
        .max(12)
        .safeParse(product?.images.map((image) => image.artifactId))
      if (!ids.success)
        throw new VintedToolError(
          'INVALID_REQUEST',
          'Controlled product image artifacts are required.',
        )
      const result = await this.call('upload', {
        target: plan.target,
        artifactIds: ids.data,
      })
      if (object(result)?.completed !== true) review('Image upload was not acknowledged.')
      return
    }
    if (plan.action === 'fill' || plan.action === 'select') {
      if (product) {
        const known = [
          product.title,
          product.description,
          product.category,
          product.condition,
          product.brand,
          product.size,
          product.currency,
          String(product.price),
          product.price.toFixed(2),
        ]
        if (!known.includes(plan.value) || !plan.value)
          review('The proposed value is not a supplied product fact.')
      }
      const result = await this.call(plan.action, {
        target: plan.target,
        value: plan.value,
      })
      if (object(result)?.completed !== true)
        review('Form preparation was not acknowledged.')
      return
    }
    const result = await this.call('click', { target: plan.target })
    if (object(result)?.completed !== true)
      review('The browser action was not acknowledged.')
  }

  async readListingForm(): Promise<ObservedListingForm> {
    const snapshot = await this.snapshot()
    if (safeUrl(snapshot.url, this.origin).pathname !== '/items/new')
      review('The listing form is not open.')
    const fields: Record<string, Target> = {}
    let priceLabel = ''
    for (const key of ['title', 'description', 'price'] as const) {
      const candidates = snapshot.controls.filter(
        (control) =>
          ['textbox', 'spinbutton'].includes(control.role) &&
          formLabel(key, control.name),
      )
      if (candidates.length !== 1)
        review(
          'Listing fields are missing or ambiguous; the observed page requires review.',
        )
      fields[key] = { index: candidates[0]!.index }
      if (key === 'price') priceLabel = candidates[0]!.name
    }
    const currencies = snapshot.controls.filter((control) =>
      formLabel('currency', control.name),
    )
    if (currencies.length > 1) review('The listing currency is ambiguous.')
    if (currencies[0]) fields.currency = { index: currencies[0].index }
    const result = await this.call('readFields', { fields })
    const parsed = z
      .strictObject({
        title: z.string().min(1).max(500),
        description: z.string().min(1).max(6000),
        price: z.string().min(1).max(64),
        currency: z.string().max(64).optional(),
      })
      .safeParse(result)
    if (!parsed.success) review('The complete listing form could not be read.')
    const currency = currencyEvidence(
      [priceLabel, parsed.data.price, parsed.data.currency ?? ''].join(' '),
    )
    if (
      !currency ||
      (parsed.data.currency !== undefined && !currencyEvidence(parsed.data.currency))
    ) {
      review(
        'The listing currency is missing or conflicting; it cannot be inferred from the hostname.',
      )
    }
    const price = parsed.data.price.replace(/\b[A-Z]{3}\b|[€£]/gu, '').trim()
    if (!/^(?:0|[1-9]\d{0,11})(?:[.,]\d{1,4})?$/u.test(price))
      review('The complete numeric listing price could not be read.')
    return {
      title: parsed.data.title,
      description: parsed.data.description,
      price,
      currency,
    }
  }

  async readMessageForm(conversationId: string): Promise<{ text: string }> {
    if (numericId(conversationId) !== conversationId) {
      throw new VintedToolError('INVALID_REQUEST', 'Invalid conversation ID.')
    }
    const snapshot = await this.snapshot()
    if (new URL(snapshot.url).pathname !== `/inbox/${conversationId}`)
      review('The assigned conversation is not open.')
    const candidates = snapshot.controls.filter(
      (control) =>
        control.role === 'textbox' &&
        !['password', 'hidden', 'search', 'email', 'tel', 'url'].includes(
          control.type ?? '',
        ) &&
        !hasLabel('search', control.name) &&
        !/password|token|cookie|secret/iu.test(control.name),
    )
    if (candidates.length !== 1) review('The message composer is missing or ambiguous.')
    const result = await this.call('readFields', {
      fields: { text: { index: candidates[0]!.index } },
    })
    const parsed = z.strictObject({ text: z.string().max(4000) }).safeParse(result)
    if (!parsed.success) review('The complete message composer value could not be read.')
    return parsed.data
  }

  async readListingBaseline(): Promise<ListingBaseline> {
    const snapshot = await this.snapshot()
    if (new URL(snapshot.url).pathname !== '/items/new')
      review('A new-item form is required before preparing an intent.')
    // Use the same small wardrobe sample as readAccountEvidence; the browser's
    // response byte limit still applies before IDs can be extracted.
    const body = await this.get(
      `/api/v2/wardrobe/${this.expectedUserId}/items?page=1&per_page=12&order=newest_first`,
    )
    if (!Array.isArray(body.items) || body.items.length > 12)
      review('Recent owned listing IDs could not be established before submission.')
    const pagination = object(body.pagination)
    if (
      (body.pagination !== undefined && !pagination) ||
      (pagination?.current_page !== undefined && pagination.current_page !== 1) ||
      (pagination?.per_page !== undefined && pagination.per_page !== 12)
    )
      review('The recent wardrobe page is inconsistent with the baseline request.')
    const ids: string[] = []
    for (const entry of body.items) {
      const item = object(entry)
      const id = numericId(item?.id)
      const owners = [item?.user_id, object(item?.user)?.id].filter(
        (owner) => owner !== undefined,
      )
      if (
        !id ||
        !owners.length ||
        owners.some((owner) => numericId(owner) !== this.expectedUserId)
      )
        review('Recent listing ownership is missing or inconsistent.')
      ids.push(id)
    }
    const parsed = baselineListingIds.safeParse(ids)
    if (!parsed.success) review('The recent listing IDs are invalid or duplicated.')
    return {
      url: snapshot.url,
      listingIds: parsed.data,
      observedAt: new Date().toISOString(),
    }
  }

  private async conversationMessages(
    conversationId: string,
  ): Promise<Record<string, unknown>[]> {
    const body = await this.get(`/api/v2/conversations/${conversationId}`)
    const conversation = object(body.conversation)
    if (
      !conversation ||
      numericId(conversation.id) !== conversationId ||
      !Array.isArray(conversation.messages) ||
      conversation.messages.length > 200
    )
      review('Conversation messages could not be read completely.')
    const messages: Record<string, unknown>[] = []
    for (const entry of conversation.messages) {
      const wrapper = object(entry)
      if (!wrapper) review('Conversation message evidence is malformed.')
      if (wrapper.entity_type !== undefined && wrapper.entity_type !== 'message') continue
      const message = wrapper.entity_type === 'message' ? object(wrapper.entity) : wrapper
      if (!message || !numericId(message.id))
        review('Conversation message identity is missing.')
      messages.push(message)
    }
    if (
      new Set(messages.map((message) => numericId(message.id))).size !== messages.length
    ) {
      review('Conversation message IDs are duplicated.')
    }
    return messages
  }

  async readMessageBaseline(conversationId: string): Promise<MessageBaseline> {
    if (numericId(conversationId) !== conversationId) {
      throw new VintedToolError('INVALID_REQUEST', 'Invalid conversation ID.')
    }
    const messages = await this.conversationMessages(conversationId)
    return {
      conversationId,
      messageIds: messages.map((message) => numericId(message.id)!),
      observedAt: new Date().toISOString(),
    }
  }

  async confirmListing(
    product: AgentProductSnapshot,
    baseline?: ListingConfirmationContext,
  ): Promise<{
    listingId: string
    listingUrl: string
    publishedAt: string
  }> {
    try {
      const parsedBaseline = listingConfirmation.safeParse(baseline)
      if (!parsedBaseline.success) unknownResult()
      const startedAt = intentTime(parsedBaseline.data)
      const initialUrl = safeUrl(parsedBaseline.data.url, this.origin)
      if (initialUrl.pathname !== '/items/new' || initialUrl.search || initialUrl.hash)
        unknownResult()
      let snapshot: BrowserSnapshot
      try {
        snapshot = await this.snapshot(5000)
      } catch {
        // A restored browser can have only about:blank. The actor still enforces
        // origin ownership on this read-only navigation before discovery.
        await this.call('navigate', { url: `${this.origin}/` }, 5000)
        snapshot = await this.snapshot(5000)
      }
      if (!/^\/items\/[1-9]\d{0,31}(?:-[^/]+)?\/?$/u.test(new URL(snapshot.url).pathname))
        return await this.discoverListing(product, parsedBaseline.data, startedAt)
      const id = listingId(snapshot.url, this.origin)
      if (parsedBaseline.data.listingIds.includes(id)) unknownResult()
      // Read-only reference: nexus-cart/apps/api/scripts/vendor/vintify/
      // vinted_scraper.py get_item uses GET /api/v2/items/{id}.
      const body = await this.get(`/api/v2/items/${id}`)
      const item = object(body.item)
      if (
        !item ||
        numericId(item.id) !== id ||
        item.title !== product.title ||
        item.description !== product.description
      )
        unknownResult()
      const owners = [item.user_id, object(item.user)?.id].filter(
        (owner) => owner !== undefined,
      )
      if (
        !owners.length ||
        owners.some((owner) => numericId(owner) !== this.expectedUserId)
      )
        unknownResult()
      if (
        item.url !== undefined &&
        (typeof item.url !== 'string' || listingId(item.url, this.origin) !== id)
      )
        unknownResult()
      const price = object(item.price)
      const amount = price?.amount ?? item.price
      const currency = price?.currency_code ?? item.currency
      if (
        (typeof amount !== 'string' && typeof amount !== 'number') ||
        !/^\d+(?:\.\d{1,2})?$/u.test(String(amount)) ||
        Number(amount) !== product.price
      )
        unknownResult()
      if (currency !== product.currency) unknownResult()
      const publishedAt = actionTimestamp(item.published_at ?? item.created_at, startedAt)
      if (!publishedAt) unknownResult()
      return { listingId: id, listingUrl: snapshot.url, publishedAt }
    } catch {
      return unknownResult()
    }
  }

  private async discoverListing(
    product: AgentProductSnapshot,
    baseline: ListingBaseline,
    startedAt: number,
  ): Promise<{ listingId: string; listingUrl: string; publishedAt: string }> {
    // One recent page and at most twelve short detail reads keep reconciliation
    // bounded inside the host RPC deadline, without replaying an external write.
    const body = await this.get(
      `/api/v2/wardrobe/${this.expectedUserId}/items?page=1&per_page=12&order=newest_first`,
      5000,
    )
    const pagination = object(body.pagination)
    if (
      !Array.isArray(body.items) ||
      body.items.length > 12 ||
      (body.pagination !== undefined && !pagination) ||
      (pagination?.current_page !== undefined && pagination.current_page !== 1) ||
      (pagination?.per_page !== undefined && pagination.per_page !== 12)
    )
      unknownResult()
    const ids: string[] = []
    for (const entry of body.items) {
      const item = object(entry)
      const id = numericId(item?.id)
      const owners = [item?.user_id, object(item?.user)?.id].filter(
        (owner) => owner !== undefined,
      )
      if (
        !id ||
        !owners.length ||
        owners.some((owner) => numericId(owner) !== this.expectedUserId) ||
        ids.includes(id)
      )
        unknownResult()
      ids.push(id)
    }
    const matches: Array<{ listingId: string; listingUrl: string; publishedAt: string }> =
      []
    let coversIntent =
      ids.length < 12 || ids.some((id) => baseline.listingIds.includes(id))
    for (const id of ids) {
      if (baseline.listingIds.includes(id)) continue
      const detail = await this.get(`/api/v2/items/${id}`, 5000)
      const item = object(detail.item)
      const owners = [item?.user_id, object(item?.user)?.id].filter(
        (owner) => owner !== undefined,
      )
      if (
        !item ||
        numericId(item.id) !== id ||
        !owners.length ||
        owners.some((owner) => numericId(owner) !== this.expectedUserId)
      )
        unknownResult()
      const url = item.url === undefined ? `${this.origin}/items/${id}` : item.url
      if (typeof url !== 'string' || listingId(url, this.origin) !== id) unknownResult()
      const price = object(item.price)
      const amount = price?.amount ?? item.price
      const currency = price?.currency_code ?? item.currency
      if (
        typeof item.title !== 'string' ||
        typeof item.description !== 'string' ||
        (typeof amount !== 'string' && typeof amount !== 'number') ||
        !/^\d+(?:\.\d{1,2})?$/u.test(String(amount)) ||
        typeof currency !== 'string' ||
        !observedTimestamp(item.published_at ?? item.created_at)
      )
        unknownResult()
      const publishedAt = actionTimestamp(item.published_at ?? item.created_at, startedAt)
      if (
        !publishedAt &&
        Date.parse(observedTimestamp(item.published_at ?? item.created_at)!) < startedAt
      )
        coversIntent = true
      if (
        item.title === product.title &&
        item.description === product.description &&
        (typeof amount === 'string' || typeof amount === 'number') &&
        /^\d+(?:\.\d{1,2})?$/u.test(String(amount)) &&
        Number(amount) === product.price &&
        currency === product.currency &&
        publishedAt
      )
        matches.push({ listingId: id, listingUrl: url, publishedAt })
    }
    if (!coversIntent || matches.length !== 1) unknownResult()
    return matches[0]!
  }

  async confirmMessage(
    conversationId: string,
    text: string,
    baseline?: MessageConfirmationContext,
  ): Promise<{ messageId: string; sentAt: string }> {
    if (numericId(conversationId) !== conversationId || !text || text.length > 4000) {
      throw new VintedToolError('INVALID_REQUEST', 'Invalid conversation or message.')
    }
    try {
      const parsedBaseline = messageConfirmation.safeParse(baseline)
      if (
        !parsedBaseline.success ||
        parsedBaseline.data.conversationId !== conversationId
      )
        unknownResult()
      const startedAt = intentTime(parsedBaseline.data)
      const oldIds = new Set(parsedBaseline.data.messageIds)
      const messages = await this.conversationMessages(conversationId)
      const matches: Array<{ messageId: string; sentAt: string }> = []
      for (const message of messages) {
        const authorIds = [
          message.author_id,
          message.sender_id,
          object(message.author)?.id,
        ].filter((author) => author !== undefined)
        if (
          !authorIds.length ||
          authorIds.some((author) => numericId(author) !== this.expectedUserId)
        )
          continue
        const texts = [message.body, message.text].filter((value) => value !== undefined)
        if (!texts.length || texts.some((value) => value !== text)) continue
        if (
          message.conversation_id !== undefined &&
          numericId(message.conversation_id) !== conversationId
        )
          continue
        const id = numericId(message.id)
        const sentAt = actionTimestamp(message.created_at ?? message.sent_at, startedAt)
        if (id && sentAt && !oldIds.has(id)) {
          matches.push({ messageId: id, sentAt })
        }
      }
      if (matches.length !== 1) unknownResult()
      return matches[0]!
    } catch {
      return unknownResult()
    }
  }
}
