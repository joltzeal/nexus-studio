import { useEffect, useState } from 'react'
import { Badge, Button, useLatched, usePresence, type MenuItem } from '@proxyshard/shardx-ui-kit'
import { previousProxyIpObservations } from '@nexus/plugin-contracts/proxy-pool'
import { EditIcon, RefreshIcon } from '../../../shared/icons'
import { useT } from '../../../shared/i18n'
import { PeekBody, PeekHeader, PeekPanel, PeekSection, PropertySheet } from '../../../shared/ui/peek'
import { ProxyConnectionDetails, ProxyDetailRow } from '../../../widgets/ProxyPeek/Details'
import { ProxyInspectionResult, ProxyIpHistory, ProxyProfiles } from '../../../widgets/ProxyPeek/Inspection'
import { proxyPoolApi } from '../../../raccoon/plugins/proxy-pool/api'
import { errorMessage, type ProxyRow } from '../../../raccoon/plugins/proxy-pool/model'
import { PoolTestPill } from './List'

type ProfileLink = { id: string; name: string; followsDefault: boolean }

export function ProxyDetails({ row, inventory, canReadHistory, groupName, checking, locked, canEdit, profiles, onSelectProfile, menuItems, onClose, onEdit, onCheck }: {
  row: ProxyRow | null
  inventory: readonly ProxyRow[]
  canReadHistory: boolean
  groupName: (row: ProxyRow) => string
  checking: boolean
  locked: boolean
  canEdit: (row: ProxyRow) => boolean
  profiles: readonly ProfileLink[] | null
  onSelectProfile: (id: string) => void
  menuItems: (row: ProxyRow) => MenuItem[]
  onClose: () => void
  onEdit: (row: ProxyRow) => void
  onCheck: (row: ProxyRow) => void
}) {
  const t = useT()
  const id = row?.id
  const [read, setRead] = useState<{
    id: string
    inventory: readonly ProxyRow[]
  } & ({ row: ProxyRow; error?: never } | { row?: never; error: string }) | null>(null)
  useEffect(() => {
    if (!id || !canReadHistory) return
    let active = true
    void proxyPoolApi.get(Number(id)).then(
      (result) => { if (active) setRead({ id, row: result, inventory }) },
      (cause: unknown) => {
        if (active) setRead({ id, inventory, error: errorMessage(cause) })
      },
    )
    return () => { active = false }
  }, [id, inventory, canReadHistory])
  const matching = read && read.id === id && read.inventory === inventory ? read : null
  const current = matching?.row ?? row
  const presence = usePresence(id ?? null, { maxExitMs: 250 })
  const shown = useLatched(current)
  const shownProfiles = useLatched(row ? { profiles } : null)
  if (!presence.mounted || !shown) return null

  const history = shown.ipHistory ?? previousProxyIpObservations(shown)
  const lastSuccessful = shown.checkStatus === 'ok'
  const geo = lastSuccessful ? shown.geo : null
  const place = [geo?.region, geo?.city].filter(Boolean).join(', ') || geo?.country

  return (
    <PeekPanel kind="proxy" label={t('proxyPeek.label', { name: shown.name })} presence={presence}>
      <PeekHeader
        subject={shown.id}
        title={<h2 className="m-0 min-w-0 truncate text-panel-title text-text-strong-950">{shown.name}</h2>}
        status={<PoolTestPill row={shown} busy={checking} />}
        extra={
          <Button size="3xsmall" mode="stroke" variant="neutral" data-peek-edit leftIcon={<EditIcon className="size-3.5" />} disabled={locked || !canEdit(shown)} onClick={() => onEdit(shown)}>
            {shown.origin ? '管理订阅' : t('peek.edit')}
          </Button>
        }
        primary={
          <Button size="3xsmall" mode="lighter" variant="primary" leftIcon={<RefreshIcon className="size-3.5" />} isLoading={checking} disabled={locked || !shown.enabled} onClick={() => onCheck(shown)}>
            检测出口
          </Button>
        }
        menuItems={menuItems(shown)}
        menuLabel={t('pageHeader.more')}
        closeLabel={t('peek.close')}
        onClose={onClose}
      />
      <PeekBody>
        <PeekSection id="details" title={t('proxyPeek.details')}>
          <ProxyConnectionDetails
            key={shown.id}
            protocol={shown.schemes.map((scheme) => scheme.toUpperCase()).join(' / ')}
            host={shown.host}
            port={shown.port}
            username={shown.username}
            hasPassword={shown.hasPassword}
            country={shown.geo?.countryCode ?? null}
            extra={
              <>
                <ProxyDetailRow id="group" label="分组" value={groupName(shown)} wrap selectable />
                <ProxyDetailRow id="enabled" label="状态" value={shown.enabled ? '启用' : '停用'} />
                <ProxyDetailRow id="udp" label="SOCKS UDP" value={shown.udp ? '启用' : '关闭'} />
              </>
            }
          />
        </PeekSection>
        <PeekSection id="test" title="出口检测">
          {shown.checkedAt ? (
            <ProxyInspectionResult
              ip={lastSuccessful ? shown.exitIp : null}
              place={place}
              countryCode={geo?.countryCode}
              isp={geo?.isp}
              checkedAt={shown.checkedAt}
              status={
                <>
                  {shown.checkedScheme && <Badge color="gray" size="small">{shown.checkedScheme.toUpperCase()}</Badge>}
                  <Badge color={lastSuccessful ? 'success' : 'error'} size="small">
                    {lastSuccessful && shown.latencyMs !== null ? `请求成功 · ${shown.latencyMs} ms` : lastSuccessful ? '请求成功' : '请求失败'}
                  </Badge>
                  {lastSuccessful && shown.exitIpChanged && <Badge color="information" size="small">出口 IP 已变化</Badge>}
                </>
              }
              error={shown.checkError && <p className="m-0 text-secondary text-error-text" data-selectable>{shown.checkError}</p>}
            />
          ) : <p className="m-0 text-secondary text-text-soft-400">{t('proxyPeek.notTested')}</p>}
          <ProxyIpHistory items={history} />
          {matching?.error && <p className="m-0 text-secondary text-error-text">IP 历史读取失败 · {matching.error}</p>}
        </PeekSection>
        <PeekSection id="reputation" title="出口与风险">
          <Reputation row={shown} />
        </PeekSection>
        <PeekSection id="profiles" title={t('proxyPeek.profiles')}>
          <ProxyProfiles profiles={shownProfiles?.profiles ?? null} onSelect={onSelectProfile} />
        </PeekSection>
      </PeekBody>
    </PeekPanel>
  )
}

function Reputation({ row }: { row: ProxyRow }) {
  const reputation = row.reputation
  const risk = reputation?.status === 'ok' ? reputation.risk : null
  const displayFlag = (value: boolean | null | undefined) =>
    reputation?.status !== 'ok' || value == null ? '未知' : value ? '是' : '否'
  const rows = [
    ['score', '出口评分', risk === null ? '未知' : `${100 - risk} / 100`],
    ['risk', '风险分数', risk === null ? '未知' : `${risk} / 100`],
    ['proxy', '代理识别', displayFlag(reputation?.proxy)],
    ['vpn', 'VPN', displayFlag(reputation?.vpn)],
    ['hosting', '数据中心', displayFlag(reputation?.hosting)],
    ['type', '网络类型', reputation?.networkType],
    ['provider', '提供方', reputation?.provider],
    ['asn', 'ASN', reputation?.asn],
    ['message', '查询说明', reputation?.error || row.geo?.error],
  ] as const
  return (
    <>
      {row.checkStatus === 'failed' && row.exitIp && (
        <p className="m-0 text-secondary text-text-soft-400">上次成功的出口 · {row.exitIp}</p>
      )}
      <PropertySheet>
        <div className="flex flex-col gap-[2px]">
          {rows.map(([id, label, value]) => <ProxyDetailRow key={id} id={id} label={label} value={value ?? '—'} empty={value == null} wrap selectable />)}
        </div>
      </PropertySheet>
    </>
  )
}
