import { buildRedactedUrl, parseProxyUrl } from '../domain/credentials.js'
import { invalidRequest } from '../domain/errors.js'
import type {
  CheckInput,
  CheckResult,
  EndpointRecord,
  GeoLocation,
  IpReputation,
  Scheme,
} from '../domain/schemas.js'
import type { PrivateStore, StoreDocument } from '../store/private-store.js'
import type { SecretVault } from '../store/secret-vault.js'
import {
  describeTransportError,
  type HttpResponse,
  type ProxyTarget,
} from './proxy-transport.js'

const EXIT_IP_URL = new URL('https://api64.ipify.org?format=json')
const REQUEST_TIMEOUT_MS = 15_000

export interface CheckDependencies {
  vault: SecretVault
  transport: (
    target: ProxyTarget,
    url: URL,
    options: { timeoutMs: number },
  ) => Promise<HttpResponse>
  reputation: (ip: string) => Promise<IpReputation>
  now: () => Date
}

export interface CheckControl {
  /** Throws when the call already exceeded its deadline or was cancelled. */
  assertAlive: () => void
}

export function chooseScheme(row: EndpointRecord, preferred: Scheme | null): Scheme {
  if (preferred !== null) {
    if (!row.schemes.includes(preferred)) {
      throw invalidRequest(`代理 ${row.id} 未配置所选协议 ${preferred.toUpperCase()}`)
    }
    return preferred
  }
  const order: Scheme[] = ['socks5h', 'socks5', 'http', 'https']
  const found = order.find((scheme) => row.schemes.includes(scheme))
  if (found === undefined) {
    throw invalidRequest(`代理 ${row.id} 没有可用协议`)
  }
  return found
}

function unavailableGeo(reputation: IpReputation): GeoLocation {
  const status = reputation.status === 'non_public' ? 'non_public' : 'unavailable'
  return {
    status,
    source: 'proxycheck.io',
    country: null,
    countryCode: null,
    region: null,
    city: null,
    isp: null,
    error:
      status === 'non_public'
        ? null
        : reputation.status === 'disabled'
          ? '在线属地查询已关闭'
          : '在线属地服务暂不可用',
  }
}

/** One network round trip. Nothing is persisted here. */
export async function performCheck(
  row: EndpointRecord,
  input: CheckInput,
  deps: CheckDependencies,
): Promise<CheckResult> {
  const preferred =
    input.singleSchemeFallback && row.schemes.length === 1
      ? (row.schemes[0] ?? null)
      : input.scheme
  const scheme = chooseScheme(row, preferred)
  const password = row.secretRef === null ? '' : await deps.vault.resolve(row.secretRef)
  const measured = await measureTarget(
    {
      scheme,
      host: row.host,
      port: row.port,
      username: row.username,
      password,
    },
    deps,
    deps.now(),
  )
  return { id: String(row.id), saved: false, ...measured }
}

/**
 * The network half of a check: exit IP, then geo and reputation for that IP.
 * Both `proxy.check` and `proxy.probe` go through it, so a window gate and the
 * pool table can never disagree about what "available" means.
 */
export async function measureTarget(
  target: ProxyTarget,
  deps: Pick<CheckDependencies, 'transport' | 'reputation'>,
  checkedAt: Date,
): Promise<Omit<CheckResult, 'id' | 'saved'>> {
  const started = performance.now()
  const result: Omit<CheckResult, 'id' | 'saved'> = {
    ok: false,
    scheme: target.scheme,
    exitIp: null,
    geo: null,
    reputation: null,
    latencyMs: 0,
    error: null,
    checkedAt: checkedAt.toISOString(),
  }

  try {
    const response = await deps.transport(target, EXIT_IP_URL, {
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
    if (response.status === 407) {
      result.error = '代理认证失败（HTTP 407）'
    } else if (response.status !== 200) {
      result.error = `出口检测服务返回 HTTP ${response.status}`
    } else {
      try {
        const payload = JSON.parse(response.body) as { ip?: unknown }
        const ip = typeof payload.ip === 'string' ? payload.ip.trim() : ''
        if (ip === '') throw new Error('missing ip')
        result.exitIp = ip
        result.ok = true
      } catch {
        result.error = '出口检测服务未返回有效 IP'
      }
    }
  } catch (error) {
    result.error = describeTransportError(error)
  }

  result.latencyMs = Math.max(0, Math.round(performance.now() - started))
  if (result.ok && result.exitIp !== null) {
    const reputation = await deps.reputation(result.exitIp)
    result.reputation = reputation
    result.geo = reputation.geo ?? unavailableGeo(reputation)
  }
  return result
}

/**
 * Checks a proxy URL the user typed but has not saved. Nothing is written to
 * the pool: this answers "does it work right now", not "add it".
 */
export async function probeProxy(
  url: string,
  deps: Pick<CheckDependencies, 'transport' | 'reputation' | 'now'>,
): Promise<CheckResult> {
  const parsed = parseProxyUrl(url)
  const measured = await measureTarget(
    {
      scheme: parsed.scheme,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
    },
    deps,
    deps.now(),
  )
  return { id: '', saved: false, ...measured }
}

interface Snapshot {
  id: number
  fingerprint: string
  schemes: string
}

function snapshotOf(row: EndpointRecord): Snapshot {
  return { id: row.id, fingerprint: row.fingerprint, schemes: row.schemes.join(',') }
}

/**
 * Applies a result only if the row is unchanged since the request started and
 * no newer observation exists. Late, stale or cancelled results are dropped.
 */
export function applyCheckResult(
  document: StoreDocument,
  result: CheckResult,
  snapshot: Snapshot,
): boolean {
  const row = document.endpoints.find((entry) => entry.id === snapshot.id)
  if (row === undefined || row.deleted) return false
  if (row.fingerprint !== snapshot.fingerprint) return false
  if (row.schemes.join(',') !== snapshot.schemes) return false
  if (row.checkedAt !== null && new Date(row.checkedAt) > new Date(result.checkedAt)) {
    return false
  }

  row.checkStatus = result.ok ? 'ok' : 'failed'
  row.checkedAt = result.checkedAt
  row.checkedScheme = result.scheme
  row.latencyMs = result.latencyMs
  row.checkError = result.error
  if (result.ok && result.exitIp !== null) {
    // Compare against the committed observation, not the request snapshot.
    row.previousExitIp = row.exitIp
    row.previousExitIpCheckedAt = row.exitIpCheckedAt
    row.exitIp = result.exitIp
    row.exitIpCheckedAt = result.checkedAt
    row.geo = result.geo
    row.reputation = result.reputation
    const reputation = result.reputation
    const validRisk =
      reputation !== null && reputation.status === 'ok' && reputation.ip === result.exitIp
    row.riskScore = validRisk ? reputation.risk : null
    row.isProxy = validRisk ? reputation.proxy : null
    row.isVpn = validRisk ? reputation.vpn : null
    row.isHosting = validRisk ? reputation.hosting : null
  }
  row.updatedAt = result.checkedAt
  return true
}

export async function checkEndpoint(
  store: PrivateStore,
  id: number,
  input: CheckInput,
  deps: CheckDependencies,
  control: CheckControl,
): Promise<CheckResult> {
  const document = await store.read()
  const row = document.endpoints.find((entry) => entry.id === id && !entry.deleted)
  if (row === undefined) throw invalidRequest('代理不存在或已删除')

  const result = await performCheck(row, input, deps)
  // A timed-out or cancelled call must not change host state afterwards.
  control.assertAlive()

  const saved = await store.mutate((draft) =>
    applyCheckResult(draft, result, snapshotOf(row)),
  )
  return { ...result, saved }
}

/** Connection URL without the credential value; the host composes the secret. */
export function describeTarget(
  row: EndpointRecord,
  scheme: Scheme,
): { url: string; requiresSecret: boolean } {
  return {
    url: buildRedactedUrl(scheme, row.host, row.port, row.username),
    requiresSecret: row.secretRef !== null,
  }
}
