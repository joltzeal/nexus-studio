import { useEffect, useRef, useState } from 'react'
import { Alert, DialogModal, Input, Switch } from '@proxyshard/shardx-ui-kit'
import type {
  ProviderAccount,
  ProxySiteDefinition,
} from '@nexus/plugin-contracts/proxy-pool'
import { errorMessage } from '../../../raccoon/plugins/proxy-pool/model'
import { proxySiteApi } from '../../../raccoon/plugins/proxy-pool/providers'

export function ProviderAccountDialog({
  provider,
  editing,
  onClose,
  onSaved,
}: {
  provider: ProxySiteDefinition
  editing: ProviderAccount | null
  onClose: () => void
  onSaved: (account: ProviderAccount) => void
}) {
  const initialName = editing?.name ?? provider.name
  const [name, setName] = useState(initialName)
  const [enabled, setEnabled] = useState(editing?.enabled ?? true)
  const [username, setUsername] = useState(editing?.username ?? '')
  const [apiKey, setApiKey] = useState<string>()
  const [password, setPassword] = useState<string>()
  const [endpointCount, setEndpointCount] = useState(String(editing?.endpointCount ?? 10))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saving = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function save() {
    if (saving.current) return
    const count = Number(endpointCount)
    if (!name.trim() || !Number.isInteger(count) || count < 1 || count > 1000) {
      setError('请填写接入名称，API 入口数量须为 1 至 1000 的整数')
      return
    }
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      const account = await proxySiteApi.saveAccount({
        ...(editing ? { id: editing.id } : {}),
        providerId: provider.id,
        name: name.trim(),
        enabled,
        username: username.trim(),
        endpointCount: count,
        ...(apiKey === undefined ? {} : { apiKey: apiKey.trim() || null }),
        ...(password === undefined ? {} : { proxyPassword: password || null }),
      })
      if (mounted.current) onSaved(account)
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause))
    } finally {
      saving.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <DialogModal
      open
      title={`${editing ? '编辑' : '添加'} ${provider.name} 接入`}
      size="lg"
      dirty={
        name !== initialName ||
        enabled !== (editing?.enabled ?? true) ||
        username !== (editing?.username ?? '') ||
        apiKey !== undefined ||
        password !== undefined ||
        endpointCount !== String(editing?.endpointCount ?? 10)
      }
      onOpenChange={(open) => {
        if (!open && !saving.current) onClose()
      }}
      onCancel={() => {
        if (!saving.current) onClose()
      }}
      confirmLabel="保存接入"
      onConfirm={() => void save()}
      isLoading={busy}
    >
      <fieldset disabled={busy} className="flex flex-col gap-4 py-4">
        <Input
          label="接入名称"
          inputSize="xsmall"
          maxLength={128}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {provider.apiProducts.length > 0 && (
          <>
            <p className="text-secondary text-text-sub-600">
              手动订阅只需接入名称。以下字段用于 API 同步。
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                label="API Key"
                secret
                type="password"
                inputSize="xsmall"
                maxLength={1024}
                value={apiKey ?? ''}
                placeholder={editing?.hasApiKey ? '已配置' : '选填'}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <Input
                label="API 入口数量"
                type="number"
                inputSize="xsmall"
                min={1}
                max={1000}
                value={endpointCount}
                onChange={(event) => setEndpointCount(event.target.value)}
              />
              <Input
                label="代理用户名"
                inputSize="xsmall"
                maxLength={128}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
              <Input
                label="代理密码"
                secret
                type="password"
                inputSize="xsmall"
                maxLength={512}
                value={password ?? ''}
                placeholder={editing?.hasProxyPassword ? '已配置' : '选填'}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </>
        )}
        <Switch
          label="启用接入"
          disabled={busy}
          checked={enabled}
          onChange={setEnabled}
        />
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
      </fieldset>
    </DialogModal>
  )
}
