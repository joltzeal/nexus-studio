/**
 * Username generation.
 *
 * The previous approach was `faker.internet.username()` plus a uniform random
 * number between 10 and 9999, which produced strings like `marie.laurent4821`
 * that no real marketplace account ever uses. This module models what people
 * actually pick instead:
 *
 * - the name itself, in one of the shapes people type (`marie.laurent`,
 *   `marielaurent`, `marie_laurent`, `mlaurent`, `laurent.marie`);
 * - an optional short number that reads like a birth year or a small
 *   disambiguator (`marie.laurent94`, `laurent7`), never a four-digit lottery.
 *
 * Everything is lowercase ASCII, starts with a letter, and is 4-20 characters,
 * which is the range the address generator targets for its output.
 */

const MIN_LENGTH = 4
const MAX_LENGTH = 20
const MAX_ATTEMPTS = 24

/**
 * Letters that Unicode NFD does not split into a base letter plus a combining
 * mark, so a plain "strip combining marks" pass would delete them.
 */
const TRANSLITERATION: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  ı: 'i',
  ħ: 'h',
  ŋ: 'n',
}

/** `Łukasz Wiśniewski` → `lukasz` / `wisniewski`. */
export function asciiName(value: string): string {
  let output = value.toLowerCase()
  output = output.replace(
    /[ßæœøđðþłıħŋ]/g,
    (character) => TRANSLITERATION[character] ?? character,
  )
  return output
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '')
}

interface Template {
  /** Relative frequency. The values are weights, not percentages. */
  weight: number
  build: (first: string, last: string, digits: string) => string
}

const TEMPLATES: readonly Template[] = [
  // `marie.laurent` — the most common shape on resale marketplaces.
  { weight: 16, build: (first, last) => `${first}.${last}` },
  // `marielaurent` — no separator, very common when the pair is short.
  { weight: 14, build: (first, last) => `${first}${last}` },
  // `marie_laurent`
  { weight: 11, build: (first, last) => `${first}_${last}` },
  // `marie.laurent94`
  { weight: 10, build: (first, last, digits) => `${first}.${last}${digits}` },
  // `marielaurent94`
  { weight: 9, build: (first, last, digits) => `${first}${last}${digits}` },
  // `mlaurent` — initial plus surname.
  { weight: 8, build: (first, last) => `${first.slice(0, 1)}${last}` },
  // `laurent.marie` — surname first, as some people prefer.
  { weight: 7, build: (first, last) => `${last}.${first}` },
  // `marie-laurent`
  { weight: 6, build: (first, last) => `${first}-${last}` },
  // `marie94` / `laurent7` — single name plus a small number.
  { weight: 6, build: (first, _last, digits) => `${first}${digits}` },
  { weight: 6, build: (first, last, digits) => `${first}-${last}${digits}` },
  { weight: 7, build: (_first, last, digits) => `${last}${digits}` },
]

const TOTAL_WEIGHT = TEMPLATES.reduce((sum, template) => sum + template.weight, 0)

/**
 * Numbers people actually append: a birth year (`94`, `2001`) or a small
 * disambiguator (`7`). A uniform 10-9999 draw is what made the old output look
 * machine-generated.
 */
export function numberSuffix(random: () => number): string {
  const roll = random()
  if (roll < 0.55) {
    // Two-digit birth year, 1970-2005.
    const year = 1970 + Math.floor(random() * 36)
    return String(year % 100).padStart(2, '0')
  }
  if (roll < 0.8) return String(1 + Math.floor(random() * 9))
  if (roll < 0.92) return String(1975 + Math.floor(random() * 31))
  return String(10 + Math.floor(random() * 90))
}

function chooseTemplate(random: () => number): Template {
  let target = random() * TOTAL_WEIGHT
  for (const template of TEMPLATES) {
    target -= template.weight
    if (target <= 0) return template
  }
  return TEMPLATES[0] as Template
}

function trimSeparators(value: string): string {
  return value.replace(/^[._-]+/, '').replace(/[._-]+$/, '')
}

export interface UsernameInput {
  firstName: string
  lastName: string
  /** Usernames already handed out in this batch. */
  taken?: ReadonlySet<string>
  random?: () => number
}

/**
 * Builds one username. Uniqueness is checked against `taken`; on collision the
 * template is re-rolled a bounded number of times and then a numeric counter is
 * appended, so a large batch still terminates.
 */
export function generateUsername({
  firstName,
  lastName,
  taken,
  random = Math.random,
}: UsernameInput): string {
  const first = asciiName(firstName)
  const last = asciiName(lastName)
  const used = taken ?? new Set<string>()

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const template = chooseTemplate(random)
    const candidate = finalise(template, first, last, random)
    if (candidate !== null && !used.has(candidate)) return candidate
  }

  // Deterministic fallback: a short base plus an incrementing counter.
  const base = trimSeparators(`${first}.${last}`.slice(0, MAX_LENGTH - 3)) || 'user'
  for (let counter = 2; counter < 10_000; counter++) {
    const candidate = `${base}${counter}`.slice(0, MAX_LENGTH)
    if (!used.has(candidate)) return candidate
  }
  return `${base}${Math.floor(random() * 9000 + 1000)}`.slice(0, MAX_LENGTH)
}

function finalise(
  template: Template,
  first: string,
  last: string,
  random: () => number,
): string | null {
  const digits = numberSuffix(random)
  let value = trimSeparators(template.build(first, last, digits))

  if (value.length > MAX_LENGTH) {
    // Drop the number before shortening the name.
    value = trimSeparators(template.build(first, last, ''))
  }
  if (value.length > MAX_LENGTH) {
    const overflow = value.length - MAX_LENGTH
    const shortenedLast = last.slice(0, Math.max(3, last.length - overflow))
    value = trimSeparators(template.build(first, shortenedLast, ''))
  }
  if (value.length > MAX_LENGTH) {
    value = trimSeparators(template.build(first.slice(0, 4), last.slice(0, 4), ''))
  }
  if (value.length > MAX_LENGTH) value = value.slice(0, MAX_LENGTH)
  if (value.length < MIN_LENGTH) {
    value = `${value}${numberSuffix(random)}`.slice(0, MAX_LENGTH)
  }
  value = trimSeparators(value)
  // A handle must start with a letter; nothing in the templates can, but the
  // guard keeps the invariant local to this module.
  if (!/^[a-z]/.test(value) || value.length < MIN_LENGTH) return null
  return value
}

/**
 * Stateful allocator for one batch: keeps the set of usernames it already
 * returned so two rows never collide.
 */
export function createUsernameAllocator(random: () => number = Math.random) {
  const taken = new Set<string>()
  return (firstName: string, lastName: string): string => {
    const username = generateUsername({ firstName, lastName, taken, random })
    taken.add(username)
    return username
  }
}
