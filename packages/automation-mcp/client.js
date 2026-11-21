// SPDX-License-Identifier: MIT
// HTTP bridge adapted from ProxyShard/ShardBrowser mcp/index.js at
// 99e780e2e685e5b3b5357c5baee8796e10b3ce1e. See LICENSE.upstream.

/** The endpoint is supplied explicitly because Rust defaults to an ephemeral port. */
export function createApiClient({ endpoint, token, fetchImpl = fetch }) {
  let base
  try {
    base = new URL(endpoint)
  } catch {
    throw new Error('RACCOON_AUTOMATION_API must be an explicit loopback HTTP URL')
  }
  if (
    base.protocol !== 'http:' ||
    base.hostname !== '127.0.0.1' ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash
  ) {
    throw new Error(
      'RACCOON_AUTOMATION_API must use http://127.0.0.1 with the listener port',
    )
  }
  if (typeof token !== 'string' || !token.trim() || /\s/.test(token)) {
    throw new Error(
      'RACCOON_AUTOMATION_TOKEN must contain the desktop-issued Bearer token',
    )
  }

  return async function api(path, { connectionId, method = 'GET', body } = {}) {
    if (
      typeof connectionId !== 'string' ||
      !connectionId ||
      connectionId.length > 256 ||
      connectionId.trim() !== connectionId ||
      Array.from(connectionId).some(
        (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
      )
    ) {
      throw new Error('Every automation request requires an explicit connectionId')
    }
    if (!path.startsWith('/automation/') || path.includes('?') || path.includes('#')) {
      throw new Error('Invalid automation route')
    }
    const url = new URL(base)
    url.pathname = path
    url.searchParams.set('connectionId', connectionId)
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
      })
    } catch {
      throw new Error(
        'The local automation request did not return a result. Reconcile its state before retrying a write with side effects.',
      )
    }
    let data
    try {
      data = await response.json()
    } catch {
      throw new Error(
        `The automation API returned an invalid response (HTTP ${response.status})`,
      )
    }
    if (!response.ok) {
      const code = typeof data?.code === 'string' ? data.code : `http_${response.status}`
      const message =
        typeof data?.error === 'string' ? data.error : 'Automation request failed'
      throw new Error(`${code}: ${message}`)
    }
    return data
  }
}
