import { SCHEMES, type Scheme } from './types'

export interface ParsedProxyLink {
  scheme: Scheme
  host: string
  port: number
  username: string
  password: string
  /** Which spelling the input used; shown to the user so nothing is a surprise. */
  format: 'userinfo' | 'colon-chain'
}

const MAX_LENGTH = 4096

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function toPort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) return null
  const port = Number(value)
  return port >= 1 && port <= 65535 ? port : null
}

/** `[::1]:1080` → host `::1`, port `1080`; `host:1080` → host, port. */
function splitHostPort(value: string): { host: string; port: string } | null {
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end < 0) return null
    const host = value.slice(1, end)
    const rest = value.slice(end + 1)
    if (!rest.startsWith(':')) return null
    return { host, port: rest.slice(1) }
  }
  const index = value.lastIndexOf(':')
  if (index <= 0) return null
  return { host: value.slice(0, index), port: value.slice(index + 1) }
}

/**
 * Reads the two spellings providers actually hand out:
 *
 *   socks5://user:pass@host:port      (standard userinfo)
 *   socks5://host:port:user:pass      (colon chain, used by rotating proxies)
 *
 * Returns `null` instead of guessing. A bare host — including an IPv6 literal
 * such as `[::1]:1080` — has no `://`, so it is never treated as a link.
 */
export function parseProxyLink(raw: string): ParsedProxyLink | null {
  let text = raw.trim()
  if (text === '' || text.length > MAX_LENGTH) return null
  // Pasting from a spreadsheet or a chat message often brings quotes along.
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('<') && text.endsWith('>'))
  ) {
    text = text.slice(1, -1).trim()
  }
  if (/\s/.test(text)) return null

  const separator = text.indexOf('://')
  if (separator <= 0) return null
  const scheme = text.slice(0, separator).toLowerCase()
  if (!(SCHEMES as readonly string[]).includes(scheme)) return null
  let rest = text.slice(separator + 3)
  if (rest.endsWith('/')) rest = rest.slice(0, -1)
  if (rest === '') return null

  // A colon chain whose password contains `@` looks like userinfo at first
  // glance, so a failed userinfo read falls through instead of giving up.
  return parseUserinfo(scheme as Scheme, rest) ?? parseColonChain(scheme as Scheme, rest)
}

function parseUserinfo(scheme: Scheme, rest: string): ParsedProxyLink | null {
  const at = rest.lastIndexOf('@')
  if (at <= 0) return null
  const userinfo = rest.slice(0, at)
  const parts = splitHostPort(rest.slice(at + 1))
  if (parts === null) return null
  const port = toPort(parts.port)
  if (port === null) return null
  const colon = userinfo.indexOf(':')
  return {
    scheme,
    host: parts.host,
    port,
    username: decode(colon < 0 ? userinfo : userinfo.slice(0, colon)),
    password: colon < 0 ? '' : decode(userinfo.slice(colon + 1)),
    format: 'userinfo',
  }
}

/** `host:port[:username[:password]]` — the password may itself contain colons. */
function parseColonChain(scheme: Scheme, rest: string): ParsedProxyLink | null {
  const head = rest.startsWith('[')
    ? rest.slice(0, rest.indexOf(']') + 1)
    : (rest.split(':')[0] ?? '')
  const tail = rest.slice(head.length)
  if (!tail.startsWith(':')) return null
  const fields = tail.slice(1).split(':')
  const host = head.replace(/^\[|\]$/g, '')
  const port = toPort(fields[0] ?? '')
  if (host === '' || port === null) return null
  return {
    scheme,
    host,
    port,
    username: fields.length > 1 ? (fields[1] ?? '') : '',
    password: fields.length > 2 ? fields.slice(2).join(':') : '',
    format: 'colon-chain',
  }
}
