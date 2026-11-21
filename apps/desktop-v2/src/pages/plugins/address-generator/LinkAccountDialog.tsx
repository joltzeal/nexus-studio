import { useEffect, useState } from 'react'
import { Alert, Button, DialogModal, Input } from '@proxyshard/shardx-ui-kit'
import { accountsApi } from '../../../raccoon/plugins/vinted-accounts/api'
import type { AccountAddressTarget } from '../../../raccoon/plugins/vinted-accounts/model'
import { addressApi } from '../../../raccoon/plugins/address-generator/client'
import { createAddressRelations } from '../../../raccoon/plugins/address-generator/relations'
import {
  addressText,
  type Profile,
  type SavedProfile,
} from '../../../raccoon/plugins/address-generator/model'
import { usePluginTask } from '../usePluginTask'

const link = createAddressRelations(addressApi, accountsApi)
export function LinkAccountDialog({
  profile,
  onSaved,
  onClose,
}: {
  profile: Profile
  onSaved: (profile: SavedProfile, durable: boolean) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [items, setItems] = useState<AccountAddressTarget[]>([])
  const [pending, setPending] = useState<AccountAddressTarget | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [durable, setDurable] = useState(true)
  const task = usePluginTask()
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    void accountsApi
      .addressTargets(query, page, 20)
      .then(
        (result) => {
          if (!alive) return
          setItems(result.items)
          setTotal(result.total)
          setDurable(result.storageDurable)
        },
        (cause) => {
          if (alive) setError(cause instanceof Error ? cause.message : '账号列表读取失败')
        },
      )
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [query, page])
  async function confirm() {
    if (!pending || !task.acquire()) return
    const token = task.begin()
    setBusy(true)
    setError(null)
    try {
      const result = await link(
        profile,
        pending,
        (item, durable) => {
          setSaved(true)
          onSaved(item, durable)
        },
        () => task.current(token),
      )
      if (!task.current(token) || !result) return
      if (!result.addressDurable || !result.accountDurable) {
        setError('已关联，但至少一个插件使用内存存储，退出后关系或地址会丢失')
        setPending(null)
      } else onClose()
    } catch (cause) {
      if (task.current(token))
        setError(cause instanceof Error ? cause.message : '关联失败，请核对后重试')
    } finally {
      task.release()
      if (task.current(token)) setBusy(false)
    }
  }
  return (
    <DialogModal
      open
      title={pending ? '确认账号地址' : '关联 Vinted 账号'}
      subtitle="只读取账号标识与地址，不读取密码"
      size="lg"
      confirmLabel="保存并关联"
      isDisabled={!pending || loading}
      isLoading={busy}
      onConfirm={() => void confirm()}
      onCancel={() => {
        if (!busy) {
          if (pending) setPending(null)
          else onClose()
        }
      }}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <div className="flex flex-col gap-4 py-inset">
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        {saved && (
          <Alert status="information" variant="lighter">
            地址已经保存；账号关联失败时可以保留选择并重试
          </Alert>
        )}
        {!durable && (
          <Alert status="warning" variant="lighter">
            账号池使用内存存储，关联在退出后失效
          </Alert>
        )}
        {pending ? (
          <>
            <p className="m-0 text-body text-text-strong-950">{pending.account}</p>
            {pending.address && (
              <div>
                <p className="m-0 mb-2 text-secondary text-text-soft-400">
                  当前地址（确认后替换）
                </p>
                <p className="m-0 whitespace-pre-line text-secondary text-text-sub-600">
                  {addressText(pending.address)}
                </p>
              </div>
            )}
            <div>
              <p className="m-0 mb-2 text-secondary text-text-soft-400">将要关联的地址</p>
              <p className="m-0 whitespace-pre-line text-body text-text-strong-950">
                {addressText(profile)}
              </p>
            </div>
          </>
        ) : (
          <>
            <Input
              inputSize="small"
              label="搜索账号"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(1)
              }}
            />
            <div className="max-h-[320px] overflow-y-auto">
              {loading ? (
                <p role="status">正在读取账号…</p>
              ) : items.length === 0 ? (
                <p className="text-secondary text-text-soft-400">没有匹配的账号</p>
              ) : (
                items.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 row-line py-3"
                  >
                    <div className="min-w-0">
                      <p className="m-0 truncate text-body text-text-strong-950">
                        {item.account}
                      </p>
                      <p className="m-0 truncate text-help text-text-soft-400">
                        {item.address
                          ? `${item.address.houseNumber} ${item.address.street} · ${item.address.city}`
                          : '未关联地址'}
                      </p>
                    </div>
                    <Button
                      size="xsmall"
                      mode="stroke"
                      variant="neutral"
                      onClick={() => setPending(item)}
                    >
                      选择
                    </Button>
                  </div>
                ))
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-secondary tabular-nums text-text-soft-400">
                {total} 个账号
              </span>
              <div className="flex gap-2">
                <Button
                  size="xsmall"
                  mode="ghost"
                  variant="neutral"
                  disabled={loading || page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </Button>
                <Button
                  size="xsmall"
                  mode="ghost"
                  variant="neutral"
                  disabled={loading || page * 20 >= total}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </DialogModal>
  )
}
