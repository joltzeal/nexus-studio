import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  DialogModal,
  Input,
  Select,
  Switch,
} from '@proxyshard/shardx-ui-kit'
import { listAllProxies, proxyPoolApi } from '../../../raccoon/plugins/proxy-pool/api'
import {
  addressOf,
  errorMessage,
  type ProxyConfig,
  type ProxyRow,
} from '../../../raccoon/plugins/proxy-pool/model'

export function ProxyConfigDialog({
  config,
  onClose,
  onSaved,
}: {
  config: ProxyConfig
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [defaultId, setDefaultId] = useState(config.defaultEndpointId ?? 'none')
  const [risk, setRisk] = useState(config.risk.enabled)
  const [cache, setCache] = useState(String(config.risk.cacheSeconds))
  const [keyMode, setKeyMode] = useState('keep')
  const [key, setKey] = useState('')
  const [rows, setRows] = useState<ProxyRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setLoaded(false)
    setError(null)
    void listAllProxies()
      .then((items) => {
        if (active) {
          setRows(items)
          setLoaded(true)
        }
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause))
      })
    return () => {
      active = false
    }
  }, [attempt])

  async function save() {
    if (busy || !loaded) return
    const seconds = Number(cache)
    if (!cache.trim() || !Number.isInteger(seconds) || seconds < 0 || seconds > 86400) {
      setError('缓存时间需要是 0–86400 之间的整数秒')
      return
    }
    if (keyMode === 'replace' && !key) {
      setError('请输入密钥')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await proxyPoolApi.saveConfig({
        defaultEndpointId: defaultId === 'none' ? null : defaultId,
        riskEnabled: risk,
        riskCacheSeconds: seconds,
        ...(keyMode === 'replace' ? { riskApiKey: key } : {}),
        ...(keyMode === 'clear' ? { riskApiKey: '' } : {}),
      })
      setKey('')
      await onSaved()
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const missing = defaultId !== 'none' && !rows.some((row) => row.id === defaultId)
  const dirty =
    defaultId !== (config.defaultEndpointId ?? 'none') ||
    risk !== config.risk.enabled ||
    cache !== String(config.risk.cacheSeconds) ||
    keyMode !== 'keep'
  return (
    <DialogModal
      open
      title="代理池配置"
      dirty={dirty}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
      onCancel={() => {
        if (!busy) onClose()
      }}
      cancelLabel="取消"
      confirmLabel="保存配置"
      onConfirm={() => void save()}
      isLoading={busy}
      isDisabled={!loaded}
    >
      <fieldset disabled={busy} className="flex flex-col gap-4 py-4">
        {error && (
          <Alert status="error" variant="lighter">
            {error}
            {!loaded && (
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                onClick={() => setAttempt((value) => value + 1)}
              >
                重新读取
              </Button>
            )}
          </Alert>
        )}
        <Select
          label="默认代理"
          size="xsmall"
          isSearchable
          disabled={!loaded}
          value={defaultId}
          onChange={setDefaultId}
          options={[
            { value: 'none', label: '不指定默认代理' },
            ...(missing
              ? [
                  {
                    value: defaultId,
                    label: `端点 ${defaultId} · 当前不可用`,
                    disabled: true,
                  },
                ]
              : []),
            ...rows.map((row) => ({
              value: row.id,
              label: `${row.name} · ${addressOf(row)} · ${row.username || '未设置用户名'}`,
              disabled: !row.enabled,
            })),
          ]}
          hint={
            loaded
              ? '跟随默认的 Profile 在默认项缺失或停用时会阻断启动'
              : '正在读取完整代理库存'
          }
        />
        <Switch label="出口 IP 风险检测" checked={risk} onChange={setRisk} />
        <Input
          label="风险结果缓存（秒）"
          inputSize="xsmall"
          inputMode="numeric"
          value={cache}
          onChange={(event) => setCache(event.target.value)}
          hint="0 表示每次查询，最长 86400 秒"
        />
        <Select
          label="proxycheck.io 密钥"
          size="xsmall"
          value={keyMode}
          onChange={(value) => {
            setKeyMode(value)
            setKey('')
          }}
          options={[
            {
              value: 'keep',
              label: config.risk.hasApiKey
                ? '保留已保存的密钥'
                : '保留当前配置 · 未保存密钥',
            },
            { value: 'replace', label: '设置新密钥' },
            { value: 'clear', label: '清除密钥' },
          ]}
        />
        {keyMode === 'replace' && (
          <Input
            label="新密钥"
            secret
            type="password"
            inputSize="xsmall"
            value={key}
            maxLength={512}
            onChange={(event) => setKey(event.target.value)}
          />
        )}
        <p className="text-help text-text-soft-400">
          风险查询使用 proxycheck.io。密钥明文保存在插件私有目录
        </p>
      </fieldset>
    </DialogModal>
  )
}
