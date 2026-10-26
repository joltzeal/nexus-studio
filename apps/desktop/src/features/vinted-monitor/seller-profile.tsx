import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ItemImage } from './item-image'
import { VintedExternalLink } from './external-link'
import { formatTime, type SellerSummary } from './types'

export function SellerProfile({
  seller,
  itemId,
}: {
  seller: SellerSummary
  itemId: string
}) {
  const name = seller.name || seller.login || seller.externalId
  const values = [
    ['卖家 ID', seller.externalId],
    ['商品数', seller.itemCount],
    ['评价数', seller.feedbackCount],
    ['评价信誉', seller.feedbackReputation],
    ['粉丝数', seller.followersCount],
    ['国家', seller.country],
    ['城市', seller.city],
    ['最近登录', formatTime(seller.lastLogedOnTs)],
    ['资料更新时间', formatTime(seller.updatedOn)],
    ['资料采集时间', formatTime(seller.collectedAt)],
    ['最近尝试时间', formatTime(seller.checkedAt)],
  ]
  const labels: Record<string, string> = {
    email: '邮箱',
    facebook: 'Facebook',
    google: 'Google',
    phone: '手机号',
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        {seller.avatarUrl ? (
          <span className="size-10 shrink-0 overflow-hidden rounded-full">
            <ItemImage itemId={itemId} url={seller.avatarUrl} alt={name} />
          </span>
        ) : null}
        <div>
          <p className="font-medium">{name}</p>
          <VintedExternalLink href={seller.profileUrl}>查看卖家主页</VintedExternalLink>
        </div>
      </div>
      {seller.error ? (
        <p className="text-xs text-destructive" role="status">
          卖家资料读取失败：{seller.error}
        </p>
      ) : null}
      <dl className="vinted-detail-values">
        {values.map(([label, value]) => (
          <div key={String(label)}>
            <dt>{label}</dt>
            <dd>{value ?? '—'}</dd>
          </div>
        ))}
      </dl>
      <h4 className="text-xs font-medium">账号验证</h4>
      {Object.entries(seller.verification ?? {}).length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>方式</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>可用性</TableHead>
              <TableHead>验证时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Object.entries(seller.verification).map(([provider, value]) => (
              <TableRow key={provider}>
                <TableCell>{labels[provider] ?? provider}</TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {value.valid === null ? '未知' : value.valid ? '已验证' : '未验证'}
                  </Badge>
                </TableCell>
                <TableCell>
                  {value.available === null
                    ? '未知'
                    : value.available
                      ? '可用'
                      : '不可用'}
                </TableCell>
                <TableCell>{formatTime(value.verifiedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-xs text-muted-foreground">尚无账号验证信息</p>
      )}
    </div>
  )
}

export function SellerPopover({
  seller,
  itemId,
}: {
  seller: SellerSummary
  itemId: string
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="vinted-text-link">
          {seller.login || seller.name || seller.externalId}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[75vh] w-[min(30rem,calc(100vw-2rem))] overflow-auto"
      >
        <SellerProfile seller={seller} itemId={itemId} />
      </PopoverContent>
    </Popover>
  )
}
