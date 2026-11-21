import type { ReactNode } from 'react'
import { Button, Modal } from '@proxyshard/shardx-ui-kit'
import {
  addressOf,
  dateTime,
  type ProxyRow,
} from '../../../raccoon/plugins/proxy-pool/model'

function DetailGroup({ title, rows }: { title: string; rows: [string, ReactNode][] }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-ui font-medium text-text-strong-950">{title}</h3>
      <dl>
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="row-line grid grid-cols-[112px_minmax(0,1fr)] gap-4 py-2"
          >
            <dt className="text-secondary text-text-soft-400">{label}</dt>
            <dd className="min-w-0 select-text whitespace-pre-wrap break-all text-ui text-text-strong-950">
              {value ?? '—'}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

export function ProxyDetails({
  row,
  groupName,
  onClose,
  onEdit,
}: {
  row: ProxyRow
  groupName: string
  onClose: () => void
  onEdit?: () => void
}) {
  const booleanText = (value: boolean | null | undefined) =>
    value === null || value === undefined ? '未知' : value ? '是' : '否'
  return (
    <Modal
      open
      title={row.name}
      size="lg"
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      footer={
        <>
          <Button size="xsmall" mode="stroke" variant="neutral" onClick={onClose}>
            关闭
          </Button>
          {onEdit && (
            <Button size="xsmall" onClick={onEdit}>
              {row.origin ? '管理服务商订阅' : '编辑代理'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <DetailGroup
          title="连接"
          rows={[
            ['地址', <code>{addressOf(row)}</code>],
            ['用户名', row.username || '未设置'],
            ['密码', row.hasPassword ? '已配置' : '未配置'],
            ['协议', row.schemes.map((scheme) => scheme.toUpperCase()).join(' / ')],
            ['分组', groupName],
            ['状态', row.enabled ? '启用' : '停用'],
            ['SOCKS UDP', row.udp ? '启用' : '关闭'],
          ]}
        />
        <DetailGroup
          title="最近检测"
          rows={[
            [
              '检测结果',
              row.checkStatus === 'ok'
                ? '连接成功'
                : row.checkStatus === 'failed'
                  ? '连接失败'
                  : '未检测',
            ],
            ['时间', dateTime(row.checkedAt)],
            ['协议', row.checkedScheme?.toUpperCase()],
            ['出口 IP', row.exitIp],
            ['延迟', row.latencyMs === null ? null : `${row.latencyMs} ms`],
            ['上次出口 IP', row.previousExitIp],
            [
              '上次出口时间',
              row.previousExitIpCheckedAt ? dateTime(row.previousExitIpCheckedAt) : null,
            ],
            ['错误', row.checkError],
          ]}
        />
        <DetailGroup
          title="属地与风险"
          rows={[
            [
              '地区',
              [row.geo?.country, row.geo?.region, row.geo?.city]
                .filter(Boolean)
                .join(' · ') || null,
            ],
            ['ISP', row.geo?.isp],
            ['风险分数', row.reputation?.status === 'ok' ? row.reputation.risk : '未知'],
            ['代理', booleanText(row.reputation?.proxy)],
            ['VPN', booleanText(row.reputation?.vpn)],
            ['数据中心', booleanText(row.reputation?.hosting)],
            ['网络类型', row.reputation?.networkType],
            ['提供方', row.reputation?.provider],
            ['ASN', row.reputation?.asn],
            ['查询说明', row.reputation?.error || row.geo?.error],
          ]}
        />
      </div>
    </Modal>
  )
}
