/**
 * Verification codes arrive in wildly different shapes: a JSON endpoint, a
 * plain-text mailbox, or a full HTML email with the digits buried in markup.
 * They do agree on one thing — the code is a short run of digits near the word
 * "code" — so that is what this looks for, with a plain six-digit fallback.
 */
const CODE_NEAR_KEYWORD = /(?:code|otp|验证码|verification)\D{0,32}(\d{4,8})/i

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

/**
 * `null` means "no code here" rather than "empty": the caller reports that as a
 * failure instead of handing the page a blank code.
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
  if (candidates.length === 0) candidates.push(plainText(trimmed))

  for (const text of candidates) {
    const match = CODE_NEAR_KEYWORD.exec(text)
    if (match?.[1] !== undefined) return match[1]
  }

  // Vinted sends six digits; four-digit runs are far more likely to be a year.
  const sixes = candidates.join(' ').match(/\b\d{6}\b/g)
  return sixes?.[0] ?? null
}
