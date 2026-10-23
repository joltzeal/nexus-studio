/**
 * A verification code is four or six digits and nothing else. A message body
 * also carries years, prices, order numbers and tracking ids, so the digits are
 * only trusted when the body agrees on a single value: two different runs mean
 * the code cannot be identified, which is better reported as "not here yet"
 * than guessed at.
 */
const DIGITS = '(?<!\\d)(\\d{6}|\\d{4})(?!\\d)'
const KEYWORD_CODE = new RegExp(
  `(?:code|otp|验证码|verification)\\D{0,32}${DIGITS}`,
  'gi',
)
const ANY_CODE = new RegExp(DIGITS, 'g')

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
}

/** Script and style blocks carry numbers that are never the code. */
export function plainText(body: string): string {
  return decodeEntities(
    body.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Keys are kept next to their values so `{"code": "654321"}` still reads as a
 * keyword match instead of a bare number.
 */
function collectStrings(value: unknown, out: string[], key = ''): void {
  if (typeof value === 'string' || typeof value === 'number') {
    out.push(key === '' ? String(value) : `${key} ${String(value)}`)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, key)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, item] of Object.entries(value)) {
      collectStrings(item, out, childKey)
    }
  }
}

/** `2026` is a copyright year far more often than it is a code. */
function isYear(digits: string): boolean {
  if (digits.length !== 4) return false
  const year = Number(digits)
  return year >= 1900 && year <= 2100
}

function matches(pattern: RegExp, text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(pattern)) {
    const value = match[1]
    if (value !== undefined && !isYear(value)) found.push(value)
  }
  return found
}

/** Exactly one distinct value, or nothing: two candidates are not a code. */
function only(values: readonly string[]): string | null {
  const distinct = new Set(values)
  if (distinct.size !== 1) return null
  return [...distinct][0] ?? null
}

/**
 * `null` means "no code here" rather than "empty": the caller reports that as a
 * missing code instead of handing the page a blank one.
 */
export function extractOtp(body: string, contentType = ''): string | null {
  const trimmed = body.trim()
  if (trimmed === '') return null

  const candidates: string[] = []
  const looksJson =
    contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')
  if (looksJson) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      collectStrings(parsed, candidates)
    } catch {
      // Labelled as JSON but is not: the text path handles it just as well.
    }
  }
  candidates.push(plainText(trimmed))

  // A keyword next to the digits is the strongest signal, and it survives a body
  // that also mentions prices or dates.
  const anchored = only(candidates.flatMap((text) => matches(KEYWORD_CODE, text)))
  if (anchored !== null) return anchored

  return only(candidates.flatMap((text) => matches(ANY_CODE, text)))
}
