import { useRef, useState } from 'react'
import { Copy, Loader2, MapPin, Unlink } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
import type { Account, AccountAddressSetResult, AssignedAccountAddress } from './types'

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
  const [open, setOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<{
    accountId: string
    accountName: string
    address: AssignedAccountAddress
  } | null>(null)
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
    if (!ready || request.current || !confirmation) return
    if (
      account.id !== confirmation.accountId ||
      address?.id !== confirmation.address.id ||
      address.linkedAt !== confirmation.address.linkedAt
    ) {
      setError('账号地址已变化，请取消并刷新资料后重新确认。')
      return
    }
    request.current = true
    setPending(true)
    setError(null)
    onPendingChange(true)
    try {
      const saved = await assignAccountAddress(account.id, null, address.id)
      await onUnlinked(saved)
      setConfirmation(null)
      toast.success(saved.storageDurable ? '地址已解绑' : '地址已解绑（仅本次运行）')
    } catch {
      setError('解绑地址失败，请检查插件状态或刷新账号资料后重试。')
    } finally {
      request.current = false
      setPending(false)
      onPendingChange(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!request.current && confirmation === null) setOpen(next)
      }}
    >
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
        {error && confirmation === null ? (
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
            onClick={() => {
              if (!ready || request.current) return
              setError(null)
              setConfirmation({
                accountId: account.id,
                accountName: account.account,
                address,
              })
            }}
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
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(next) => {
          if (!next && !request.current) {
            setConfirmation(null)
            setError(null)
          }
        }}
      >
        {confirmation ? (
          <AlertDialogContent
            onEscapeKeyDown={(event) => {
              if (request.current) event.preventDefault()
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>确认解绑账号地址？</AlertDialogTitle>
              <AlertDialogDescription>
                将解除账号「{confirmation.accountName}」与地址「
                {confirmation.address.postalCode} {confirmation.address.city}
                」的关联，移除此账号保存的完整地址快照，影响所有关联窗口。
                地址生成器中的原资料会保留，Vinted 平台上的地址不会改变。
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={!ready || pending}
                onClick={(event) => {
                  event.preventDefault()
                  void unlink()
                }}
              >
                {pending ? '正在解绑…' : '确认解绑地址'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </Popover>
  )
}
