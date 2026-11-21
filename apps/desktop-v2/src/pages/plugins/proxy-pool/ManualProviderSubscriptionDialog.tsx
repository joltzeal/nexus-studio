import { useEffect, useRef, useState } from 'react'
import { Alert, DialogModal, Input, Select, Switch } from '@proxyshard/shardx-ui-kit'
import type {
  ProviderSubscription,
  ProxyProduct,
} from '@nexus/plugin-contracts/proxy-pool'
import {
  errorMessage,
  SCHEMES,
  type Scheme,
} from '../../../raccoon/plugins/proxy-pool/model'
import {
  PROXY_PRODUCT_LABELS,
  proxySiteApi,
} from '../../../raccoon/plugins/proxy-pool/providers'

const maxFileSize = 500_000

function localDateTime(iso: string | null | undefined) {
  if (!iso) return ''
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}

async function readTxt(file: File) {
  if (!/\.txt$/i.test(file.name) || file.size < 1 || file.size > maxFileSize)
    throw new Error('请选择 1 至 500000 字节的 TXT 文件')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
  } catch {
    throw new Error('无法读取 TXT，请确认文件使用 UTF-8 编码')
  }
  if (!text.trim()) throw new Error('TXT 文件没有代理记录')
  if (text.split(/\r?\n/).filter((line) => line.trim() !== '').length > 1000)
    throw new Error('TXT 文件最多包含 1000 条代理')
  return text
}

export function ManualProviderSubscriptionDialog({
  accountId,
  providerName,
  products,
  editing,
  onClose,
  onSaved,
}: {
  accountId: string
  providerName: string
  products: ProxyProduct[]
  editing: ProviderSubscription | null
  onClose: () => void
  onSaved: (result: Awaited<ReturnType<typeof proxySiteApi.saveManual>>) => void
}) {
  const initialExpiry = localDateTime(editing?.expiresAt)
  const initialProduct = editing?.productType ?? products[0] ?? ''
  const [name, setName] = useState(editing?.name ?? '')
  const [product, setProduct] = useState(initialProduct)
  const [expiry, setExpiry] = useState(initialExpiry)
  const [enabled, setEnabled] = useState(editing?.enabled ?? true)
  const [scheme, setScheme] = useState<Scheme>('http')
  const [file, setFile] = useState<File | null>(null)
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
    const productType = products.find((item) => item === product)
    if (!name.trim() || !productType) {
      setError('请填写订阅名称并选择产品类型')
      return
    }
    const parsedExpiry = new Date(expiry)
    if (
      !Number.isFinite(parsedExpiry.getTime()) ||
      localDateTime(parsedExpiry.toISOString()) !== expiry
    ) {
      setError('请填写有效的到期日期和时间')
      return
    }
    if (!editing && !file) {
      setError('请上传代理 TXT 文件')
      return
    }
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      const text = file ? await readTxt(file) : undefined
      if (!mounted.current) return
      const result = await proxySiteApi.saveManual({
        ...(editing ? { id: editing.id } : {}),
        accountId,
        name: name.trim(),
        productType,
        enabled,
        scheme,
        expiresAt:
          expiry === initialExpiry && editing?.expiresAt
            ? editing.expiresAt
            : parsedExpiry.toISOString(),
        ...(text === undefined ? {} : { text }),
      })
      if (mounted.current) onSaved(result)
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
      title={editing ? `编辑 ${providerName} 手动订阅` : `新建 ${providerName} 手动订阅`}
      size="lg"
      dirty={
        name !== (editing?.name ?? '') ||
        product !== initialProduct ||
        expiry !== initialExpiry ||
        enabled !== (editing?.enabled ?? true) ||
        file !== null
      }
      onOpenChange={(open) => {
        if (!open && !saving.current) onClose()
      }}
      onCancel={() => {
        if (!saving.current) onClose()
      }}
      confirmLabel="保存订阅"
      onConfirm={() => void save()}
      isLoading={busy}
    >
      <fieldset disabled={busy} className="flex flex-col gap-4 py-4">
        <Input
          label="订阅名称"
          type="text"
          inputSize="xsmall"
          maxLength={128}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            label="产品类型"
            size="xsmall"
            disabled={busy}
            value={product}
            options={products.map((value) => ({
              value,
              label: PROXY_PRODUCT_LABELS[value],
            }))}
            onChange={(value) => {
              const next = products.find((item) => item === value)
              if (next) setProduct(next)
            }}
          />
          <Input
            label="到期时间（本地时间）"
            type="datetime-local"
            inputSize="xsmall"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
          />
        </div>
        <Input
          label={editing ? '替换代理 TXT（可选）' : '代理 TXT'}
          type="file"
          inputSize="xsmall"
          accept=".txt,text/plain"
          hint={
            editing
              ? '留空可只续期或修改订阅信息。上传后会替换订阅的代理列表。'
              : 'UTF-8，每行一条，最多 1000 条、500000 字节。'
          }
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null)
            setError(null)
          }}
        />
        {file && (
          <Select
            label="无协议行使用的协议"
            size="xsmall"
            disabled={busy}
            value={scheme}
            hint="支持代理 URL、主机:端口、主机:端口:用户名:密码。"
            options={SCHEMES.map((value) => ({ value, label: value.toUpperCase() }))}
            onChange={(value) => {
              const next = SCHEMES.find((item) => item === value)
              if (next) setScheme(next)
            }}
          />
        )}
        <Switch
          label="启用订阅"
          checked={enabled}
          disabled={busy}
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
