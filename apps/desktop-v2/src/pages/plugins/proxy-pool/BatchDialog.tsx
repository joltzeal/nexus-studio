import { useState } from 'react'
import { Alert, DialogModal, Select, Textarea } from '@proxyshard/shardx-ui-kit'
import { proxyPoolApi } from '../../../raccoon/plugins/proxy-pool/api'
import {
  errorMessage,
  type BatchResult,
  type ProxyGroup,
} from '../../../raccoon/plugins/proxy-pool/model'

export function ProxyBatchDialog({
  groups,
  onClose,
  onSaved,
}: {
  groups: ProxyGroup[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [urls, setUrls] = useState('')
  const [group, setGroup] = useState('none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BatchResult | null>(null)

  async function save() {
    if (busy) return
    if (!urls.trim()) {
      setError('请粘贴代理 URL')
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await proxyPoolApi.import(urls, group === 'none' ? null : Number(group)))
      setUrls('')
      await onSaved()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogModal
      open
      title="批量添加代理"
      size="lg"
      dirty={Boolean(urls)}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
      onCancel={() => {
        if (!busy) onClose()
      }}
      cancelLabel="关闭"
      confirmLabel="导入代理"
      onConfirm={() => void save()}
      isLoading={busy}
    >
      <fieldset disabled={busy} className="flex flex-col gap-4 py-4">
        <Select
          label="分组"
          size="xsmall"
          value={group}
          onChange={setGroup}
          hint="重复配置合并协议，并保留原分组"
          options={[
            { value: 'none', label: '未分组' },
            ...groups.map((item) => ({ value: String(item.id), label: item.name })),
          ]}
        />
        <Textarea
          label="代理 URL"
          technical
          rows={10}
          maxLength={500000}
          value={urls}
          placeholder={
            'socks5://user:pass@proxy.example.com:1080\nhttp://proxy.example.com:8080'
          }
          hint="每行一条完整 URL，单次最多 1000 条"
          onChange={(event) => setUrls(event.target.value)}
        />
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        {result && (
          <Alert status="information" variant="lighter">
            处理 {result.requested} 条，新增 {result.created} 条，合并 {result.merged}{' '}
            条，重复 {result.duplicates} 条
          </Alert>
        )}
      </fieldset>
    </DialogModal>
  )
}
