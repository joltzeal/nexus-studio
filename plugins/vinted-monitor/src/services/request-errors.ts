import {
  UpstreamError,
  type UpstreamPhase,
  type UpstreamReason,
} from '../domain/errors.js'
import { record } from '../domain/sellers.js'

export function statusFailure(status: number, phase: UpstreamPhase): UpstreamError {
  let reason: UpstreamReason = 'upstream-refused'
  if (status >= 300 && status < 400) reason = 'redirect'
  else if (status === 429) reason = 'rate-limit'
  else if (status === 401 || status === 403) reason = 'blocked'
  else if (status === 407) reason = 'proxy-auth'
  else if (status === 408 || status === 504) reason = 'timeout'
  else if (status >= 500) reason = 'unavailable'
  return new UpstreamError(reason, null, { status, phase })
}

/** Inspect known transport codes, but never copy exception text into run records. */
export function networkFailure(error: unknown, phase: UpstreamPhase): UpstreamError {
  let reason: UpstreamReason = 'upstream-network'
  let cause = record(error)
  for (let depth = 0; cause && depth < 8; depth += 1, cause = record(cause.cause)) {
    const code = typeof cause.code === 'string' ? cause.code : ''
    const message = typeof cause.message === 'string' ? cause.message : ''
    if (/^Proxy response \(407\) !== 200 when HTTP Tunneling$/.test(message)) {
      return new UpstreamError('proxy-auth', null, { phase, status: 407 })
    }
    if (cause.name === 'SocksClientError' && /authentication|auth method/i.test(message))
      return new UpstreamError('proxy-auth', null, { phase })
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') reason = 'dns'
    else if (
      code.startsWith('ERR_TLS_') ||
      code.startsWith('ERR_SSL_') ||
      [
        'CERT_HAS_EXPIRED',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      ].includes(code)
    )
      reason = 'tls'
    else if (
      code === 'ETIMEDOUT' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT' ||
      cause.name === 'AbortError' ||
      cause.name === 'TimeoutError' ||
      message === 'Proxy connection timeout'
    )
      reason = 'timeout'
    else if (
      message === 'Proxy connection failed' ||
      /^Proxy response \(\d{3}\) !== 200 when HTTP Tunneling$/.test(message) ||
      cause.name === 'SocksClientError'
    )
      reason = 'proxy-connect'
  }
  return new UpstreamError(reason, null, { phase })
}
