import { Button, Modal } from '@proxyshard/shardx-ui-kit'
import type { AccountAddress } from '../../../raccoon/plugins/vinted-accounts/model'
import { clip } from '../../../shared/lib/clipboard'
import { toast } from '../../../shared/model/toast'

export function AddressDialog({
  name,
  address,
  onClose,
}: {
  name: string
  address: AccountAddress
  onClose: () => void
}) {
  const city =
    address.countryCode === 'US'
      ? `${address.city}${address.state ? `, ${address.state}` : ''} ${address.postalCode}`
      : `${address.postalCode} ${address.city}`
  const text = [
    `${address.firstName} ${address.lastName}`.trim(),
    address.username,
    `${address.houseNumber} ${address.street}`.trim(),
    city,
    [address.county, address.countryCode === 'US' ? null : address.state]
      .filter(Boolean)
      .join(', '),
    address.countryCode,
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <Modal
      open
      title={`账号地址 · ${name}`}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      footer={
        <>
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            onClick={() =>
              void clip.write(text).then(
                () => toast.ok('完整地址已复制'),
                (cause) => toast.fail({ title: '地址复制失败', detail: cause }),
              )
            }
          >
            复制完整地址
          </Button>
          <Button size="xsmall" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      <p className="whitespace-pre-line break-words text-secondary text-text-sub-600">
        {text}
      </p>
      <p className="text-micro text-text-soft-400">
        关联于 {new Date(address.linkedAt).toLocaleString()}
        {address.approximate ? ' · 近似地址' : ''}
      </p>
    </Modal>
  )
}
