import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  AlertModal,
  Button,
  EmptyState,
  Modal,
  Select,
} from '@proxyshard/shardx-ui-kit'
import type {
  ProviderAccount,
  ProviderSubscription,
  ProxySiteDefinition,
} from '@nexus/plugin-contracts/proxy-pool'
import { errorMessage } from '../../../raccoon/plugins/proxy-pool/model'
import {
  PROXY_PRODUCT_LABELS,
  proxySiteApi,
} from '../../../raccoon/plugins/proxy-pool/providers'
import { ManualProviderSubscriptionDialog } from './ManualProviderSubscriptionDialog'
import { ProviderAccountDialog } from './ProviderAccountDialog'

type Snapshot = {
  providers: ProxySiteDefinition[]
  accounts: ProviderAccount[]
  subscriptions: ProviderSubscription[]
}
type Editor =
  | { kind: 'account'; provider: ProxySiteDefinition; editing: ProviderAccount | null }
  | {
      kind: 'manual'
      provider: ProxySiteDefinition
      accountId: string
      editing: ProviderSubscription | null
    }
type Deletion = { kind: 'account' | 'subscription'; id: string; name: string }

export function ProvidersDialog({
  initialAccountId,
  onClose,
  onInventoryChanged,
}: {
  initialAccountId?: string
  onClose: () => void
  onInventoryChanged: () => void
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [accountId, setAccountId] = useState(initialAccountId ?? '')
  const [newProviderId, setNewProviderId] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [deleting, setDeleting] = useState<Deletion | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const mounted = useRef(false)
  const sequence = useRef(0)
  const working = useRef(false)

  const refresh = useCallback(async () => {
    const request = ++sequence.current
    const [providers, accounts, subscriptions] = await Promise.all([
      proxySiteApi.providers(),
      proxySiteApi.accounts(),
      proxySiteApi.subscriptions(),
    ])
    if (!mounted.current || sequence.current !== request) return
    setSnapshot({ providers, accounts, subscriptions })
    setAccountId((current) =>
      accounts.some((account) => account.id === current)
        ? current
        : (accounts[0]?.id ?? ''),
    )
    setNewProviderId((current) =>
      providers.some((provider) => provider.id === current)
        ? current
        : (providers[0]?.id ?? ''),
    )
  }, [])

  async function run(action: () => Promise<void>) {
    if (working.current) return
    working.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause))
    } finally {
      working.current = false
      if (mounted.current) setBusy(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    const request = sequence.current + 1
    void refresh().catch((cause) => {
      if (mounted.current && sequence.current === request) setError(errorMessage(cause))
    })
    return () => {
      mounted.current = false
      sequence.current++
    }
  }, [refresh])

  function saved(message: string) {
    setEditor(null)
    setWarnings([])
    setNotice(message)
    onInventoryChanged()
    void run(refresh)
  }

  const account = snapshot?.accounts.find((item) => item.id === accountId)
  const provider = snapshot?.providers.find((item) => item.id === account?.providerId)
  const newProvider = snapshot?.providers.find((item) => item.id === newProviderId)
  const subscriptions =
    snapshot?.subscriptions.filter((item) => item.accountId === accountId) ?? []

  return (
    <>
      <Modal
        open
        title="代理服务商"
        size="lg"
        onOpenChange={(open) => {
          if (!open && !working.current && !editor && !deleting) onClose()
        }}
      >
        <div className="flex flex-col gap-4 py-4">
          <div className="flex flex-wrap items-end gap-2">
            {snapshot && snapshot.accounts.length > 0 && (
              <Select
                label="已配置接入"
                size="xsmall"
                disabled={busy}
                value={accountId}
                options={snapshot.accounts.map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
                onChange={(id) => {
                  setAccountId(id)
                  setNotice(null)
                  setWarnings([])
                }}
              />
            )}
            {snapshot && snapshot.providers.length > 1 && (
              <Select
                label="服务商"
                size="xsmall"
                disabled={busy}
                value={newProviderId}
                options={snapshot.providers.map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
                onChange={setNewProviderId}
              />
            )}
            {newProvider && (
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={busy}
                onClick={() =>
                  setEditor({ kind: 'account', provider: newProvider, editing: null })
                }
              >
                添加 {newProvider.name} 接入
              </Button>
            )}
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              disabled={busy}
              onClick={() => void run(refresh)}
            >
              重新读取
            </Button>
          </div>
          {!snapshot && !error && <p role="status">正在读取服务商接入…</p>}
          {snapshot && !account && <EmptyState title="尚未配置代理服务商" />}
          {account && provider && (
            <>
              <p className="text-secondary text-text-sub-600">{provider.description}</p>
              <div className="flex flex-wrap items-center gap-2">
                {provider.manualProducts.length > 0 && (
                  <Button
                    size="xsmall"
                    disabled={busy}
                    onClick={() =>
                      setEditor({
                        kind: 'manual',
                        provider,
                        accountId: account.id,
                        editing: null,
                      })
                    }
                  >
                    新建手动订阅
                  </Button>
                )}
                {provider.apiProducts.length > 0 && (
                  <Button
                    size="xsmall"
                    mode="stroke"
                    variant="neutral"
                    disabled={busy || !account.enabled || !account.hasApiKey}
                    onClick={() =>
                      void run(async () => {
                        setNotice(null)
                        setWarnings([])
                        const result = await proxySiteApi.sync(account.id)
                        if (!mounted.current) return
                        setNotice(
                          `已同步 ${result.subscriptions} 个套餐、${result.endpoints} 个代理入口`,
                        )
                        setWarnings(result.warnings)
                        onInventoryChanged()
                        await refresh()
                      })
                    }
                  >
                    同步 API 套餐
                  </Button>
                )}
                <Button
                  size="xsmall"
                  mode="ghost"
                  variant="neutral"
                  disabled={busy}
                  onClick={() =>
                    setEditor({ kind: 'account', provider, editing: account })
                  }
                >
                  编辑接入
                </Button>
                <Button
                  size="xsmall"
                  mode="ghost"
                  variant="neutral"
                  disabled={busy}
                  onClick={() =>
                    setDeleting({ kind: 'account', id: account.id, name: account.name })
                  }
                >
                  删除接入
                </Button>
                {!account.enabled && (
                  <span className="text-secondary text-text-sub-600">接入已停用</span>
                )}
              </div>
              {account.lastSyncAt && (
                <p className="text-secondary text-text-sub-600">
                  上次 API 同步 {new Date(account.lastSyncAt).toLocaleString()}
                </p>
              )}
              {account.lastError && (
                <Alert status="error" variant="lighter">
                  {account.lastError}
                </Alert>
              )}
              {subscriptions.length === 0 ? (
                <EmptyState title="当前接入没有订阅" />
              ) : (
                <ul className="divide-y divide-stroke-soft-200">
                  {subscriptions.map((subscription) => (
                    <li
                      key={subscription.id}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-body">{subscription.name}</p>
                        <p className="text-secondary text-text-sub-600">
                          {PROXY_PRODUCT_LABELS[subscription.productType]} ·{' '}
                          {subscription.source === 'manual' ? '手动上传' : 'API 同步'}
                          {' · '}
                          {subscription.memberCount} 条代理
                          {subscription.expiresAt &&
                            ` · 到期 ${new Date(subscription.expiresAt).toLocaleString()}`}
                          {subscription.expired && ' · 已到期'}
                          {!subscription.enabled && ' · 已停用'}
                        </p>
                      </div>
                      {subscription.source === 'manual' && (
                        <div className="flex shrink-0 gap-1">
                          <Button
                            size="xsmall"
                            mode="ghost"
                            variant="neutral"
                            disabled={busy}
                            onClick={() =>
                              setEditor({
                                kind: 'manual',
                                provider,
                                accountId: account.id,
                                editing: subscription,
                              })
                            }
                          >
                            编辑 / 续期
                          </Button>
                          <Button
                            size="xsmall"
                            mode="ghost"
                            variant="neutral"
                            disabled={busy}
                            onClick={() =>
                              setDeleting({
                                kind: 'subscription',
                                id: subscription.id,
                                name: subscription.name,
                              })
                            }
                          >
                            删除
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {notice && (
            <Alert status="information" variant="lighter">
              {notice}
            </Alert>
          )}
          {warnings.length > 0 && (
            <Alert status="warning" variant="lighter">
              {warnings.join('。')}
            </Alert>
          )}
          {error && (
            <Alert status="error" variant="lighter">
              {error}
            </Alert>
          )}
        </div>
      </Modal>
      {editor?.kind === 'account' && (
        <ProviderAccountDialog
          provider={editor.provider}
          editing={editor.editing}
          onClose={() => setEditor(null)}
          onSaved={(account) => {
            setAccountId(account.id)
            saved('服务商接入已保存')
          }}
        />
      )}
      {editor?.kind === 'manual' && (
        <ManualProviderSubscriptionDialog
          accountId={editor.accountId}
          providerName={editor.provider.name}
          products={editor.provider.manualProducts}
          editing={editor.editing}
          onClose={() => setEditor(null)}
          onSaved={(result) =>
            saved(`手动订阅已保存，当前有 ${result.subscription.memberCount} 条代理`)
          }
        />
      )}
      <AlertModal
        open={deleting !== null}
        title={`删除 ${deleting?.name ?? ''}`}
        description="删除后，使用这些代理的 Profile 仍保留原关联，重新选择可用代理后才能启动。"
        confirmLabel="删除"
        isLoading={busy}
        onOpenChange={(open) => {
          if (!open && !working.current) setDeleting(null)
        }}
        onCancel={() => {
          if (!working.current) setDeleting(null)
        }}
        onConfirm={() => {
          if (!deleting) return
          void run(async () => {
            if (deleting.kind === 'account') await proxySiteApi.deleteAccount(deleting.id)
            else await proxySiteApi.deleteSubscription(deleting.id)
            if (!mounted.current) return
            setDeleting(null)
            setNotice('已删除')
            setWarnings([])
            onInventoryChanged()
            await refresh()
          })
        }}
      />
    </>
  )
}
