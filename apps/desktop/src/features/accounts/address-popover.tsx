import { useRef, useState } from 'react'
import { Copy, Loader2, MapPin, Unlink } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { toast } from '@/components/ui/toast'
import { streetLine } from '@/features/addresses/types'
import { copyText } from '@/lib/clipboard'
import { assignAccountAddress } from './api'
import { message } from './types'
import type { Account, AccountAddressSetResult } from './types'

interface AccountAddressPopoverProps {
  account: Pick<Account, 'id' | 'account' | 'address'>
  ready: boolean
  onUnlinked: (result: AccountAddressSetResult) => void | Promise<void>
  onPendingChange: (pending: boolean) => void
}

export function AccountAddressPopover({
  account,
  ready,
  onUnlinked,
  onPendingChange,
}: AccountAddressPopoverProps) {
  const [pending, setPending] = useState(false)
  const request = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const address = account.address ?? null

  if (address === null) return <span className="text-muted-foreground">—</span>

  const cityLine =
    address.countryCode === 'US'
      ? `${address.city}${address.state ? `, ${address.state}` : ''} ${address.postalCode}`
      : `${address.postalCode} ${address.city}`
  const regions = [address.county, address.countryCode === 'US' ? null : address.state]
    .filter(Boolean)
    .join(', ')
  const fullAddress = [
    `${address.firstName} ${address.lastName}`,
    address.username,
    streetLine(address),
    cityLine,
    regions,
    address.countryCode,
  ]
    .filter(Boolean)
    .join('\n')

  async function copy() {
    if (await copyText(fullAddress)) toast.success('完整地址已复制')
    else toast.error('复制失败，请检查剪贴板权限后重试。')
  }

  async function unlink() {
    if (!ready || request.current || address === null) return
    request.current = true
    setPending(true)
    setError(null)
    onPendingChange(true)
    try {
      const saved = await assignAccountAddress(account.id, null, address.id)
      await onUnlinked(saved)
      toast.success(saved.storageDurable ? '地址已解绑' : '地址已解绑（仅本次运行）')
    } catch (cause) {
      setError(message(cause))
    } finally {
      request.current = false
      setPending(false)
      onPendingChange(false)
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={`查看 ${account.account} 的地址`}
        >
          <MapPin data-icon="inline-start" />
          <span className="max-w-36 truncate">
            {address.postalCode} {address.city}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)]"
        aria-label={`地址详情：${account.account}`}
      >
        <PopoverHeader>
          <PopoverTitle>账号地址</PopoverTitle>
          <p className="truncate text-xs text-muted-foreground">{account.account}</p>
        </PopoverHeader>
        <p className="max-h-56 overflow-y-auto text-sm break-words whitespace-pre-line">
          {fullAddress}
        </p>
        <p className="text-xs text-muted-foreground">
          关联于 {new Date(address.linkedAt).toLocaleString('zh-CN', { hour12: false })}
          {address.approximate ? ' · 近似地址' : ''}
        </p>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
            <Copy data-icon="inline-start" />
            复制完整地址
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!ready || pending}
            aria-busy={pending}
            onClick={() => void unlink()}
          >
            {pending ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <Unlink data-icon="inline-start" />
            )}
            解绑地址
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
