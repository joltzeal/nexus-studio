import { useEffect, useState } from 'react'
import { Alert, Badge, Button, DialogModal, Input } from '@proxyshard/shardx-ui-kit'
import { usePluginCatalog } from '../../../raccoon/plugins/catalog'
import { pluginUiIdentity } from '../../../raccoon/plugins/ui-session'
import { isNativeRaccoon } from '../../../raccoon/runtime'
import { sim8Api } from '../../../raccoon/plugins/sim8/api'
import {
  createNativeSim8AccountBridge,
  type Sim8AccountTarget,
} from '../../../raccoon/plugins/sim8/accounts'
import { SIM8_CAPABILITY, SIM8_PLUGIN_ID } from '../../../raccoon/plugins/sim8/methods'
import {
  loadNumberChoices,
  numberChoicePage,
} from '../../../raccoon/plugins/sim8/number-selection'
import { shortTime, type SmsRecord } from '../../../raccoon/plugins/sim8/types'

const accountBridge = createNativeSim8AccountBridge()

export function Sim8NumberPicker({
  disabled,
  currentAccountId,
  onPick,
  onClose,
}: {
  disabled: boolean
  currentAccountId?: string
  onPick: (number: { tel: string; api: string }, identity: string) => void
  onClose?: () => void
}) {
  const plugins = usePluginCatalog((state) => state.plugins)
  const plugin = plugins.find((item) => item.id === SIM8_PLUGIN_ID)
  const ready =
    isNativeRaccoon() &&
    !!plugin?.enabled &&
    plugin.state === 'running' &&
    plugin.capabilities.includes(SIM8_CAPABILITY) &&
    plugin.granted.includes(SIM8_CAPABILITY) &&
    plugin.methods.includes('sim8.records.list')
  const identity = plugin ? pluginUiIdentity(plugin) : ''
  const [inlineOpen, setOpen] = useState(false)
  const open = !!onClose || inlineOpen
  const [records, setRecords] = useState<SmsRecord[]>([])
  const [accounts, setAccounts] = useState<Sim8AccountTarget[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!open || !ready || disabled) return
    let active = true
    setLoading(true)
    setLoadedIdentity(null)
    setError(null)
    setRecords([])
    setAccounts(null)
    void loadNumberChoices(
      () => sim8Api.records(),
      () => accountBridge.list(),
    )
      .then((result) => {
        if (active) {
          setRecords(result.records)
          setAccounts(result.accounts)
          setLoadedIdentity(identity)
        }
      })
      .catch(() => {
        if (active) {
          setError('号码池读取失败，请重试')
          setLoadedIdentity(identity)
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, ready, identity, disabled, currentAccountId, reload])
  const shown = numberChoicePage(records, accounts, currentAccountId, query, page)
  const close = () => {
    if (disabled) return
    if (onClose) onClose()
    else setOpen(false)
  }
  return (
    <>
      {!onClose && (
        <Button
          size="xsmall"
          mode="stroke"
          variant="neutral"
          disabled={disabled}
          onClick={() => {
            setQuery('')
            setPage(1)
            setOpen(true)
          }}
        >
          号码池
        </Button>
      )}
      {open && (
        <DialogModal
          open
          title="从 SIM8 号码池选择"
          size="lg"
          cancelLabel="关闭"
          onCancel={close}
          onOpenChange={(next) => {
            if (!next) close()
          }}
        >
          <div className="flex flex-col gap-3 py-inset">
            {!ready ? (
              <p role="status" className="m-0 text-secondary text-text-sub-600">
                SIM8 插件未就绪。
              </p>
            ) : (
              <>
                <Input
                  inputSize="xsmall"
                  label="搜索号码、备注或订单"
                  value={query}
                  disabled={disabled || loading}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setPage(1)
                  }}
                />
                {loading || loadedIdentity !== identity ? (
                  <p role="status" className="m-0 text-secondary text-text-sub-600">
                    正在读取号码池…
                  </p>
                ) : error ? (
                  <>
                    <Alert status="error" variant="lighter">
                      {error}
                    </Alert>
                    <Button
                      size="xsmall"
                      mode="stroke"
                      variant="neutral"
                      onClick={() => setReload((value) => value + 1)}
                    >
                      重新读取
                    </Button>
                  </>
                ) : (
                  <>
                    {accounts === null && (
                      <p role="status" className="m-0 text-help text-warning-text">
                        账号占用未知，仍可选择号码。
                      </p>
                    )}
                    {!shown.total && (
                      <p className="m-0 text-secondary text-text-sub-600">
                        没有匹配的号码。
                      </p>
                    )}
                    <div
                      className="flex max-h-80 flex-col gap-1 overflow-y-auto"
                      role="group"
                      aria-label="SIM8 号码"
                    >
                      {shown.items.map(({ record, current, others, expired }) => (
                        <Button
                          key={record.tel}
                          size="xsmall"
                          mode="ghost"
                          variant="neutral"
                          className="h-auto! justify-start! whitespace-normal! py-2! text-left!"
                          disabled={disabled || !record.api}
                          aria-label={`选择号码 ${record.tel}`}
                          onClick={() => {
                            if (
                              disabled ||
                              !ready ||
                              loading ||
                              loadedIdentity !== identity ||
                              !record.api
                            )
                              return
                            onPick({ tel: record.tel, api: record.api }, identity)
                            close()
                          }}
                        >
                          <span className="flex min-w-0 flex-col gap-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span>{record.tel}</span>
                              {current && (
                                <Badge color="primary" size="small">
                                  当前账号
                                </Badge>
                              )}
                              {expired && (
                                <Badge color="gray" size="small">
                                  已过期
                                </Badge>
                              )}
                            </span>
                            <span className="text-help text-text-sub-600">
                              {record.api
                                ? `${record.remark || '已购'} · 到期 ${shortTime(record.endTime)}`
                                : '没有接码链接'}
                            </span>
                            {others.length > 0 ? (
                              <span className="text-help text-warning-text">
                                其他账号使用{' '}
                                {others.map((owner) => owner.account).join('、')}
                              </span>
                            ) : (
                              accounts !== null &&
                              !current && (
                                <span className="text-help text-text-soft-400">
                                  暂无账号使用
                                </span>
                              )
                            )}
                          </span>
                        </Button>
                      ))}
                    </div>
                    <div className="flex items-center justify-end gap-2 text-secondary text-text-sub-600">
                      <span>
                        共 {shown.total} 个号码，第 {shown.page} / {shown.pages} 页
                      </span>
                      <Button
                        size="xsmall"
                        mode="stroke"
                        variant="neutral"
                        disabled={disabled || shown.page <= 1}
                        onClick={() => setPage(shown.page - 1)}
                      >
                        上一页
                      </Button>
                      <Button
                        size="xsmall"
                        mode="stroke"
                        variant="neutral"
                        disabled={disabled || shown.page >= shown.pages}
                        onClick={() => setPage(shown.page + 1)}
                      >
                        下一页
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </DialogModal>
      )}
    </>
  )
}
