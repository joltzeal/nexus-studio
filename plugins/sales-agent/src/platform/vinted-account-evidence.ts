import { redactText } from '../services/validation.js'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function id(value: unknown): string | undefined {
  const text =
    typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === 'string'
        ? value
        : ''
  return /^[1-9]\d{0,31}$/u.test(text) ? text : undefined
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const safe = redactText(value)
    .replace(/\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/giu, '[REDACTED EMAIL]')
    .slice(0, limit)
    .replace(/[\p{Cc}\p{Cs}]/gu, ' ')
    .trim()
  return safe || undefined
}

export function sellerProfile(
  body: Record<string, unknown>,
  identity: { id: string; username: string },
): Record<string, unknown> | undefined {
  const raw = record(body.user) ?? body
  if (
    id(raw.id) !== identity.id ||
    (raw.login !== undefined && raw.login !== identity.username) ||
    (raw.username !== undefined && raw.username !== identity.username)
  )
    return undefined
  const profile: Record<string, unknown> = {
    id: identity.id,
    username: identity.username,
  }
  const fields = {
    item_count: 'itemCount',
    given_item_count: 'givenItemCount',
    taken_item_count: 'takenItemCount',
    followers_count: 'followersCount',
    feedback_count: 'feedbackCount',
    positive_feedback_count: 'positiveFeedbackCount',
    negative_feedback_count: 'negativeFeedbackCount',
    neutral_feedback_count: 'neutralFeedbackCount',
  }
  for (const [source, target] of Object.entries(fields)) {
    const value = raw[source]
    if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 1e12
    )
      profile[target] = value
  }
  const about = text(raw.about ?? raw.description, 1000)
  if (about) profile.about = about
  if (typeof raw.business === 'boolean') profile.business = raw.business
  const verifiedEmail = record(record(raw.verification)?.email)?.valid
  if (typeof verifiedEmail === 'boolean') profile.emailVerified = verifiedEmail
  if (
    typeof raw.feedback_reputation === 'number' &&
    Number.isFinite(raw.feedback_reputation) &&
    raw.feedback_reputation >= 0 &&
    raw.feedback_reputation <= 5
  )
    profile.feedbackReputation = raw.feedback_reputation
  if (
    typeof raw.rating === 'number' &&
    Number.isFinite(raw.rating) &&
    raw.rating >= 0 &&
    raw.rating <= 5
  )
    profile.rating = raw.rating
  return profile
}

export function sellerItems(
  body: Record<string, unknown>,
  expectedUserId: string,
): Record<string, unknown>[] | undefined {
  if (!Array.isArray(body.items) || body.items.length > 100) return undefined
  const items: Record<string, unknown>[] = []
  const ids = new Set<string>()
  for (const entry of body.items) {
    const raw = record(entry)
    const itemId = id(raw?.id)
    const title = text(raw?.title, 500)
    if (!raw || !itemId || !title || ids.has(itemId)) return undefined
    const owners = [raw.user_id, record(raw.user)?.id].filter(
      (value) => value !== undefined,
    )
    if (!owners.length || owners.some((owner) => id(owner) !== expectedUserId))
      return undefined
    ids.add(itemId)
    const item: Record<string, unknown> = { id: itemId, title }
    const category = text(
      raw.category_title ??
        record(raw.catalog)?.title ??
        record(raw.category)?.title ??
        raw.category,
      160,
    )
    const categoryId = id(raw.catalog_id ?? record(raw.catalog)?.id)
    const brand = text(raw.brand_title ?? record(raw.brand)?.title, 100)
    if (category) item.category = category
    if (categoryId) item.categoryId = categoryId
    if (brand) item.brand = brand
    items.push(item)
  }
  return items.slice(0, 12)
}

export function sellerFeedback(
  body: Record<string, unknown>,
  expectedUserId: string,
): Record<string, unknown>[] | undefined {
  const entries = body.user_feedbacks
  if (!Array.isArray(entries) || entries.length > 100) return undefined
  const result: Record<string, unknown>[] = []
  const ids = new Set<string>()
  for (const entry of entries) {
    const raw = record(entry)
    const feedbackId = id(raw?.id)
    if (!raw || !feedbackId || ids.has(feedbackId)) return undefined
    const recipients = [raw.receiver_id, raw.recipient_id, raw.to_user_id].filter(
      (value) => value !== undefined,
    )
    if (recipients.some((value) => id(value) !== expectedUserId)) return undefined
    ids.add(feedbackId)
    const feedback: Record<string, unknown> = { id: feedbackId }
    const comment = text(raw.feedback ?? raw.comment ?? raw.text, 500)
    if (comment) feedback.comment = comment
    if (
      typeof raw.rating === 'number' &&
      Number.isFinite(raw.rating) &&
      raw.rating >= 0 &&
      raw.rating <= 5
    )
      feedback.rating = raw.rating
    if (
      typeof raw.value === 'number' &&
      Number.isFinite(raw.value) &&
      raw.value >= -5 &&
      raw.value <= 5
    )
      feedback.value = raw.value
    result.push(feedback)
  }
  return result.slice(0, 12)
}
