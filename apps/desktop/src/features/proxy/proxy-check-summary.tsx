import { Badge } from '@/components/ui/badge'
import { flagOf, qualityScore, type CheckResult } from './types'

function placeOf(result: CheckResult): string {
  const geo = result.geo
  if (geo === null) return '未知'
  if (geo.status === 'non_public') return '内网 / 保留地址'
  if (geo.status !== 'ok') return '属地未知'
  return [geo.country, geo.city]
    .filter((part) => part !== null && part !== '')
    .join(' · ')
}

function riskLabel(risk: number | null): string {
  if (risk === null) return '未知'
  if (risk <= 20) return '低风险'
  if (risk <= 60) return '中等风险'
  return '高风险'
}

/**
 * The four numbers a launch decision rests on. Shared by the window editor's
 * test button and the pre-launch gate so both read the same way.
 */
export function ProxyCheckSummary({ result }: { result: CheckResult }) {
  const flag = flagOf(result.geo?.countryCode ?? null)
  const quality = qualityScore(result.reputation)
  const confidence = result.reputation?.confidence ?? null
  const risk = result.reputation?.risk ?? null
  const country = result.geo?.countryCode ?? null

  return (
    <div className="proxy-check" data-state={result.ok ? 'ok' : 'failed'}>
      <div className="proxy-check-grid">
        <div>
          <span>出口 IP</span>
          <strong>{result.exitIp ?? '—'}</strong>
        </div>
        <div>
          <span>IP 属地</span>
          <strong>
            {flag === '' ? null : <span aria-hidden="true">{flag} </span>}
            {placeOf(result)}
          </strong>
        </div>
        <div>
          <span>可信度</span>
          <strong>{confidence === null ? '—' : `${confidence}%`}</strong>
        </div>
        <div>
          <span>出口质量</span>
          <strong>{quality === null ? '—' : `${quality} 分`}</strong>
        </div>
        <div>
          <span>延迟</span>
          <strong>{result.ok ? `${result.latencyMs} ms` : '—'}</strong>
        </div>
        <div>
          <span>风险</span>
          <strong>{risk === null ? '—' : `${risk} · ${riskLabel(risk)}`}</strong>
        </div>
      </div>
      <div className="proxy-check-badges">
        <Badge variant="outline">{result.scheme.toUpperCase()}</Badge>
        {country === null ? null : <Badge variant="secondary">{country}</Badge>}
        {result.reputation?.proxy === true ? (
          <Badge variant="secondary">已识别为代理</Badge>
        ) : null}
        {result.reputation?.vpn === true ? <Badge variant="secondary">VPN</Badge> : null}
        {result.reputation?.hosting === true ? (
          <Badge variant="secondary">数据中心</Badge>
        ) : null}
      </div>
      {result.error === null ? null : (
        <p className="proxy-check-error" role="alert">
          {result.error}
        </p>
      )}
    </div>
  )
}
