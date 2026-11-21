import { useEffect, useState } from 'react'
import { Alert, Button, DialogModal, Input } from '@proxyshard/shardx-ui-kit'
import { addressApi } from '../../../raccoon/plugins/address-generator/client'
import {
  ADDRESS_PLUGIN_ID,
  addressText,
  type SavedPage,
  type SavedProfile,
} from '../../../raccoon/plugins/address-generator/model'
import { supportsAddressFeature } from '../../../raccoon/plugins/address-generator/page-contract'
import { parseProfile } from '../../../raccoon/plugins/address-generator/parse'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import { pluginUiIdentity } from '../../../raccoon/plugins/ui-session'
import { accountsApi } from '../../../raccoon/plugins/vinted-accounts/api'
import type { Account } from '../../../raccoon/plugins/vinted-accounts/model'
import { usePluginTask } from '../usePluginTask'

export function AccountAddressPicker({
  account,
  sourceIdentity,
  onClose,
  onSaved,
}: {
  account: Account
  sourceIdentity: string
  onClose: () => void
  onSaved: (durable: boolean) => void
}) {
  const task = usePluginTask()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<{
    query: string
    page: number
    data: SavedPage
  } | null>(null)
  const [selected, setSelected] = useState<SavedProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void addressApi
      .list(query, page)
      .then(
        (data) => {
          if (active) setResult({ query, page, data })
        },
        (cause) => {
          if (active) {
            setResult(null)
            setError(cause instanceof Error ? cause.message : '地址库读取失败')
          }
        },
      )
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [query, page, reload])

  const shown = result?.query === query && result.page === page ? result.data : null
  function assertSource() {
    const source = usePluginCatalog
      .getState()
      .plugins.find((plugin) => plugin.id === ADDRESS_PLUGIN_ID)
    if (
      !source ||
      !supportsAddressFeature(source, 'saved') ||
      pluginUiIdentity(source) !== sourceIdentity
    )
      throw new Error('VInted helper 已变化，请重新选择地址')
  }
  async function save() {
    if (!selected || !shown || !task.acquire()) return
    const token = task.begin()
    setSaving(true)
    setError(null)
    try {
      assertSource()
      const latest = await addressApi.list(query, shown.page)
      if (!task.current(token)) return
      assertSource()
      const profile = latest.items.find((item) => item.id === selected.id)
      if (!profile || JSON.stringify(profile) !== JSON.stringify(selected))
        throw new Error('所选地址已变化，请返回并重新选择')
      const saved = await accountsApi.saveAddress(
        account.id,
        parseProfile(profile),
        account.address?.id ?? null,
      )
      if (task.current(token)) onSaved(saved.storageDurable)
    } catch (cause) {
      if (task.current(token))
        setError(cause instanceof Error ? cause.message : '地址关联失败')
    } finally {
      task.release()
      if (task.current(token)) setSaving(false)
    }
  }

  return (
    <DialogModal
      open
      size="lg"
      title={selected ? '确认关联地址' : '从 VInted helper 选择地址'}
      subtitle={account.account}
      confirmLabel="确认关联"
      cancelLabel={selected ? '返回地址库' : '关闭'}
      isLoading={saving}
      isDisabled={!selected || saving}
      onConfirm={() => void save()}
      onCancel={() => {
        if (saving) return
        if (selected) {
          setSelected(null)
          setResult(null)
          setReload((current) => current + 1)
        } else onClose()
      }}
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <div className="flex flex-col gap-3 py-inset">
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        {selected ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {account.address && (
              <div>
                <h3 className="m-0 text-secondary">当前地址</h3>
                <p className="m-0 mt-1 whitespace-pre-line break-words">
                  {addressText(account.address)}
                </p>
              </div>
            )}
            <div>
              <h3 className="m-0 text-secondary">将要关联的地址</h3>
              <p className="m-0 mt-1 whitespace-pre-line break-words">
                {addressText(selected)}
              </p>
            </div>
          </div>
        ) : (
          <>
            <Input
              type="search"
              inputSize="xsmall"
              label="搜索已保存地址"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(1)
              }}
            />
            {loading ? (
              <p role="status">正在读取地址库…</p>
            ) : shown ? (
              <>
                <ul className="m-0 max-h-72 list-none overflow-y-auto p-0">
                  {shown.items.map((item) => (
                    <li
                      key={item.id}
                      className="row-line flex items-center justify-between gap-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-body">
                          {item.houseNumber} {item.street} · {item.city}
                        </div>
                        <div className="truncate text-help text-text-sub-600">
                          {item.firstName} {item.lastName} · {item.postalCode} ·{' '}
                          {item.countryCode}
                        </div>
                      </div>
                      <Button
                        size="xsmall"
                        mode="stroke"
                        variant="neutral"
                        disabled={item.id === account.address?.id}
                        onClick={() => setSelected(item)}
                      >
                        {item.id === account.address?.id ? '已关联' : '选择'}
                      </Button>
                    </li>
                  ))}
                </ul>
                {!shown.items.length && (
                  <p className="m-0 text-secondary">
                    {query
                      ? '没有匹配的地址'
                      : '地址库为空，请先在 VInted helper 中保存地址'}
                  </p>
                )}
                {shown.total > shown.pageSize && (
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      size="xsmall"
                      mode="ghost"
                      variant="neutral"
                      disabled={shown.page <= 1}
                      onClick={() => setPage(shown.page - 1)}
                    >
                      上一页
                    </Button>
                    <span className="text-secondary tabular-nums">
                      {shown.page} / {Math.ceil(shown.total / shown.pageSize)}
                    </span>
                    <Button
                      size="xsmall"
                      mode="ghost"
                      variant="neutral"
                      disabled={shown.page * shown.pageSize >= shown.total}
                      onClick={() => setPage(shown.page + 1)}
                    >
                      下一页
                    </Button>
                  </div>
                )}
              </>
            ) : error ? (
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                onClick={() => setReload((current) => current + 1)}
              >
                重新读取
              </Button>
            ) : null}
          </>
        )}
      </div>
    </DialogModal>
  )
}
