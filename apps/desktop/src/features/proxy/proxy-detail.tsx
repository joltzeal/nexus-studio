import { useRef, useState, type ReactNode } from 'react'
import { Check, Minus, TriangleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  flagOf,
  formatDateTime,
  qualityScore,
  type IpReputation,
  type ProxyRow,
} from './types'

/** Two-column key/value list used by both detail popovers. */
export function DetailRows({ rows }: { rows: [string, ReactNode][] }) {
  const visible = rows.filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  )
  if (visible.length === 0) return null
  return (
    <dl className="proxy-detail-rows">
      {visible.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Radix opens a popover on click; the reference page opens on hover so a user
 * can scan a column without committing to a click. Both triggers stay focusable.
 */
function HoverPopover({
  label,
  trigger,
  children,
  className,
}: {
  label: string
  trigger: ReactNode
  children: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function schedule(next: boolean) {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(next), 120)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label}
        className="proxy-detail-trigger"
        onMouseEnter={() => schedule(true)}
        onMouseLeave={() => schedule(false)}
        onFocus={() => setOpen(true)}
      >
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={className ?? 'w-[min(24rem,calc(100vw-2rem))]'}
        onMouseEnter={() => schedule(true)}
        onMouseLeave={() => schedule(false)}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

const FLAGS: {
  key: keyof IpReputation
  label: string
  tone: 'warning' | 'danger' | 'info'
}[] = [
  { key: 'proxy', label: '代理', tone: 'warning' },
  { key: 'vpn', label: 'VPN', tone: 'warning' },
  { key: 'tor', label: 'TOR', tone: 'warning' },
  { key: 'hosting', label: '数据中心', tone: 'info' },
  { key: 'compromised', label: '受感染', tone: 'danger' },
  { key: 'scraper', label: '爬虫', tone: 'warning' },
]

function RiskFlags({ risk }: { risk: IpReputation }) {
  return (
    <div className="proxy-risk-flags" aria-label="风险类型识别">
      {FLAGS.map(({ key, label, tone }) => {
        const value = risk[key]
        const known = typeof value === 'boolean'
        const hit = value === true
        return (
          <span
            key={label}
            className="proxy-risk-flag"
            data-hit={hit ? 'true' : 'false'}
            data-tone={hit ? tone : 'muted'}
            title={`${label}：${known ? (hit ? '已识别' : '未识别') : '未知'}`}
          >
            {known ? (
              hit ? (
                <Check aria-hidden="true" />
              ) : (
                <Minus aria-hidden="true" />
              )
            ) : (
              <span aria-hidden="true">?</span>
            )}
            {label}
          </span>
        )
      })}
    </div>
  )
}

/** Five segments: each filled segment is 20 points of exit quality. */
function ScoreMeter({ score }: { score: number | null }) {
  const filled = score === null ? 0 : Math.round(score / 20)
  return (
    <span className="proxy-score" data-empty={score === null ? 'true' : 'false'}>
      <span className="proxy-score-meter" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((index) => (
          <span key={index} data-on={index < filled ? 'true' : 'false'} />
        ))}
      </span>
      <span className="proxy-score-value">{score === null ? '—' : score}</span>
    </span>
  )
}

function yesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return '未知'
  return value ? '是' : '否'
}

export function DetectionCell({ row }: { row: ProxyRow }) {
  const geo = row.geo
  const flag = flagOf(geo?.countryCode ?? null)
  const country =
    geo?.status === 'ok' ? (geo.country ?? geo.countryCode ?? '未知国家') : null
  const trigger =
    country ??
    (row.checkStatus === 'failed' ? '检测失败' : row.exitIp ? '未知国家' : '未检测')
  const geoStatus =
    geo === null
      ? '暂无属地数据'
      : geo.status === 'non_public'
        ? '内网 / 保留地址'
        : geo.status === 'unavailable'
          ? '属地服务不可用'
          : '暂无属地数据'
  return (
    <div className="proxy-detection">
      <HoverPopover
        label={`${trigger} · 检测详情`}
        trigger={
          <span className="proxy-detection-link">
            {flag === '' ? null : <span aria-hidden="true">{flag} </span>}
            {trigger}
          </span>
        }
      >
        <PopoverHeader>
          <PopoverTitle>检测详情</PopoverTitle>
        </PopoverHeader>
        <DetailRows
          rows={[
            [
              '检测结果',
              <Badge variant={row.checkStatus === 'failed' ? 'destructive' : 'outline'}>
                {row.checkStatus === 'ok'
                  ? '通过'
                  : row.checkStatus === 'failed'
                    ? '未通过'
                    : '未检测'}
              </Badge>,
            ],
            ['检测协议', row.checkedScheme?.toUpperCase() ?? null],
            ['联网耗时', row.latencyMs === null ? null : `${row.latencyMs} ms`],
            ['检测时间', formatDateTime(row.checkedAt)],
            ['出口 IP', row.exitIp],
            ['出口 IP 采集时间', formatDateTime(row.exitIpCheckedAt)],
            ['上次出口 IP', row.previousExitIp],
            ['上次出口 IP 采集时间', formatDateTime(row.previousExitIpCheckedAt)],
          ]}
        />
        {row.checkStatus === 'failed' && row.exitIp !== null ? (
          <p className="proxy-detail-note">
            本次检测失败，以上 IP 信息保留自上次成功检测。
          </p>
        ) : null}
        {row.checkError !== null ? (
          <p className="proxy-detail-error" role="alert">
            {row.checkError}
          </p>
        ) : null}
        <div className="proxy-detail-section">
          {geo?.status === 'ok' ? (
            <DetailRows
              rows={[
                ['国家', country],
                ['省州', geo.region],
                ['城市', geo.city],
                ['运营商', geo.isp],
              ]}
            />
          ) : (
            <p className="proxy-detail-note">{geoStatus}</p>
          )}
          <DetailRows rows={[['属地数据来源', geo?.source ?? null]]} />
          {geo?.error ? <p className="proxy-detail-note">{geo.error}</p> : null}
        </div>
      </HoverPopover>
      {row.exitIpChanged ? <span className="proxy-detection-warn">IP 已变化</span> : null}
    </div>
  )
}

export function QualityCell({ row }: { row: ProxyRow }) {
  const risk = row.reputation
  const score = qualityScore(risk)
  const label = score === null ? '暂无评分' : `IP 评分 ${score} / 100`
  const reason =
    risk === null
      ? '暂无风险数据'
      : risk.status === 'rate_limited'
        ? '风险查询额度不足'
        : risk.status === 'disabled'
          ? '风险查询已关闭'
          : risk.status === 'non_public'
            ? '内网 / 保留地址'
            : '风险服务暂不可用'
  const badges =
    risk?.status === 'ok'
      ? [
          risk.vpn === true ? 'VPN' : null,
          risk.hosting === true ? '数据中心' : null,
          score === 100 ? '满分' : null,
        ].filter((value): value is string => value !== null)
      : []
  return (
    <HoverPopover
      label={label}
      trigger={
        <span className="proxy-quality">
          <ScoreMeter score={score} />
          {badges.length === 0 ? null : (
            <span className="proxy-quality-badges">
              {badges.map((badge) => (
                <span key={badge} className="proxy-quality-badge">
                  {badge}
                </span>
              ))}
            </span>
          )}
        </span>
      }
    >
      <PopoverHeader>
        <PopoverTitle>IP 质量</PopoverTitle>
      </PopoverHeader>
      {row.checkStatus === 'failed' && risk !== null ? (
        <p className="proxy-detail-note">本次检测失败，风险信息保留自上次成功检测。</p>
      ) : null}
      {risk?.status === 'ok' ? (
        <>
          <RiskFlags risk={risk} />
          <DetailRows
            rows={[
              ['IP 评分', score === null ? null : `${score} / 100`],
              ['风险分', `${risk.risk ?? '—'} / 100`],
              ['置信度', risk.confidence === null ? null : `${risk.confidence}%`],
              ['网络类型', risk.networkType],
              ['网络提供商', risk.provider],
              ['ASN', risk.asn],
            ]}
          />
          <p className="proxy-detail-note">
            评分 = 100 − 风险分，评分越高表示风险越低，不代表纯净度百分比。
          </p>
        </>
      ) : (
        <p className="proxy-detail-note">{reason}</p>
      )}
      {risk === null ? null : (
        <DetailRows
          rows={[
            ['风险数据来源', risk.source],
            ['风险查询时间', formatDateTime(risk.checkedAt)],
            ['使用缓存', yesNo(risk.cached)],
          ]}
        />
      )}
      {risk?.error ? (
        <p className="proxy-detail-note">
          <TriangleAlert aria-hidden="true" /> {risk.error}
        </p>
      ) : null}
    </HoverPopover>
  )
}
