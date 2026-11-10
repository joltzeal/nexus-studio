import { invalidRequest, isPluginFailure, unavailable } from '../domain/errors.js'

const MAX_BODY_BYTES = 256 * 1024

/** Both expiry checks and manual reads use the link's own credentials only. */
export async function readRecordLink(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    throw invalidRequest('接码链接格式无效')
  }
  if (!['http:', 'https:'].includes(target.protocol))
    throw invalidRequest('接码链接须使用 HTTP 或 HTTPS')
  try {
    const response = await fetchImpl(target.href, {
      redirect: 'follow',
      headers: { accept: 'application/json,text/plain,text/html' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw unavailable(`接码链接返回 HTTP ${String(response.status)}`)
    }
    const reader = response.body?.getReader()
    if (!reader)
      return { body: '', contentType: response.headers.get('content-type') ?? '' }
    const decoder = new TextDecoder()
    let bytes = 0
    let body = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_BODY_BYTES) throw unavailable('接码链接响应过大')
        body += decoder.decode(chunk.value, { stream: true })
      }
      body += decoder.decode()
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    return { body, contentType: response.headers.get('content-type') ?? '' }
  } catch (error) {
    if (isPluginFailure(error)) throw error
    throw unavailable('接码链接请求失败，请检查链接是否仍然有效', error)
  }
}
