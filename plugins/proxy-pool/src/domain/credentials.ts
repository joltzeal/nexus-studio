import { createHash } from 'node:crypto'

import { invalidRequest } from './errors.js'
import type { Scheme } from './schemas.js'

export interface ParsedProxyUrl {
  scheme: Scheme
  host: string
  port: number
  username: string
  password: string
}

const schemes = new Set<string>(['http', 'https', 'socks5', 'socks5h'])
const MAX_URL_LENGTH = 4096

/**
 * Strict `scheme://user:pass@host:port` parsing. Anything else is rejected
 * instead of guessed, and the failure message never echoes the input.
 */
export function parseProxyUrl(value: string): ParsedProxyUrl {
  const text = value.trim()
  if (text.length === 0 || text.length > MAX_URL_LENGTH) {
    throw invalidRequest('代理 URL 无效，请检查协议、认证信息、主机和端口')
  }
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (/\s/.test(char) || code < 32) {
      throw invalidRequest('代理 URL 无效，请检查协议、认证信息、主机和端口')
    }
  }
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw invalidRequest('代理 URL 无效，请检查协议、认证信息、主机和端口')
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  const path = parsed.pathname
  if (
    !schemes.has(scheme) ||
    parsed.hostname === '' ||
    parsed.port === '' ||
    (path !== '' && path !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw invalidRequest('代理 URL 无效，请检查协议、认证信息、主机和端口')
  }
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalidRequest('代理 URL 无效，请检查协议、认证信息、主机和端口')
  }
  return {
    scheme: scheme as Scheme,
    host: parsed.hostname.replace(/^\[|\]$/g, ''),
    port,
    username: decodeComponent(parsed.username),
    password: decodeComponent(parsed.password),
  }
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw invalidRequest('代理 URL 无效，请检查协议、认证信息、主机和端口')
  }
}

/** Percent-encodes everything outside RFC 3986 unreserved characters. */
function encodeCredential(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export function buildConnectionUrl(
  scheme: Scheme,
  host: string,
  port: number,
  username: string,
  password: string,
): string {
  const target = host.includes(':') ? `[${host}]` : host
  const auth =
    username !== '' || password !== ''
      ? `${encodeCredential(username)}:${encodeCredential(password)}@`
      : ''
  return `${scheme}://${auth}${target}:${port}`
}

/**
 * Connection URL without the credential value. Used for export and for the
 * host's pre-launch validation, where the secret must stay in the vault.
 */
export function buildRedactedUrl(
  scheme: Scheme,
  host: string,
  port: number,
  username: string,
): string {
  const target = host.includes(':') ? `[${host}]` : host
  const auth = username === '' ? '' : `${encodeCredential(username)}@`
  return `${scheme}://${auth}${target}:${port}`
}

/**
 * Inventory identity: address plus the vault-provided credential digest. The
 * digest is computed by the vault, so the plugin never hashes a password on
 * its own and never stores one.
 */
export function endpointFingerprint(
  host: string,
  port: number,
  username: string,
  credentialFingerprint: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([host, port, username, credentialFingerprint]))
    .digest('hex')
}
