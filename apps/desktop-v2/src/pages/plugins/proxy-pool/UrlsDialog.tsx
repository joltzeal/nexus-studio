import { useEffect, useState } from 'react'
import { Alert, Button, Modal, Select, Textarea } from '@proxyshard/shardx-ui-kit'
import { clip } from '../../../shared/lib/clipboard'
import { toast } from '../../../shared/model/toast'
import { proxyPoolApi } from '../../../raccoon/plugins/proxy-pool/api'
import { errorMessage, SCHEMES, type Scheme } from '../../../raccoon/plugins/proxy-pool/model'

export type ProxyUrlsRequest = { ids: string[]; scheme: Scheme | null }

export function ProxyUrlsDialog({ request, onClose }: { request: ProxyUrlsRequest; onClose: () => void }) {
  const [scheme, setScheme] = useState(request.scheme ?? 'auto')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setBusy(true)
    setText('')
    setError(null)
    void proxyPoolApi
      .exportUrls(request.ids, scheme === 'auto' ? null : (scheme as Scheme))
      .then((data) => { if (active) setText(data.urls.join('\n')) })
      .catch((cause) => { if (active) setError(errorMessage(cause)) })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [request, scheme])
  return (
    <Modal
      open
      title="复制代理 URL"
      size="lg"
      onOpenChange={(open) => { if (!open) onClose() }}
      footer={
        <>
          <Button size="xsmall" mode="stroke" variant="neutral" onClick={onClose}>关闭</Button>
          <Button
            size="xsmall"
            disabled={busy || !text}
            onClick={() => {
              void clip.write(text).then(
                () => toast.ok('已复制代理 URL'),
                () => setError('剪贴板写入失败'),
              )
            }}
          >
            复制 URL
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select label="协议" size="xsmall" value={scheme} onChange={setScheme} options={[
          { value: 'auto', label: '自动选择' },
          ...SCHEMES.map((value) => ({ value, label: value.toUpperCase() })),
        ]} />
        {error && <Alert status="error" variant="lighter">{error}</Alert>}
        <Textarea label="代理 URL" technical rows={8} readOnly value={text} hint="URL 隐去密码，使用前需要补入密码" />
      </div>
    </Modal>
  )
}
