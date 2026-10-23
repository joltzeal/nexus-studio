import { useState } from 'react'
import { Copy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/toast'
import { copyText } from '@/lib/clipboard'
import { shortTime, type SmsRead } from './types'

/**
 * The click answer. A code is shown large enough to read across the room; a
 * body without one says so instead of pretending the fetch failed, and the raw
 * response is one button away because that is what makes a dead link debuggable.
 */
export function SmsCodeDialog({
  tel,
  result,
  onClose,
}: {
  tel: string
  result: SmsRead
  onClose: () => void
}) {
  const [raw, setRaw] = useState(false)

  async function copy() {
    if (result.code === null) return
    if (await copyText(result.code)) toast.success('验证码已复制')
    else toast.error('复制失败，请检查剪贴板权限后重试。')
  }

  return (
    <DialogContent className="otp-dialog">
      <DialogHeader>
        <DialogTitle>接码验证码</DialogTitle>
        <DialogDescription>
          {tel} · {shortTime(result.fetchedAt.replace('T', ' ').slice(0, 19))}
        </DialogDescription>
      </DialogHeader>
      {raw ? (
        <div className="otp-raw-wrap">
          <pre className="otp-raw">
            {result.body.trim() === '' ? '（响应体为空）' : result.body}
          </pre>
          {result.truncated ? (
            <p className="otp-hint">响应体较长，这里只显示前 64 KB。</p>
          ) : null}
        </div>
      ) : result.code === null ? (
        <div className="otp-verdict" data-tone="empty">
          <strong>还没有验证码</strong>
          <p>
            响应里没有唯一的 4 位或 6
            位数字。可能短信还没到，稍等几秒再读一次；也可以查看原文，确认这个接码链接到底返回了什么。
          </p>
        </div>
      ) : (
        <div className="otp-verdict" data-tone="found">
          <span className="otp-digits">{result.code}</span>
          <Button onClick={() => void copy()}>
            <Copy data-icon="inline-start" />
            复制验证码
          </Button>
        </div>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={() => setRaw((current) => !current)}>
          {raw ? '收起原文' : '查看原文'}
        </Button>
        <Button onClick={onClose}>关闭</Button>
      </DialogFooter>
    </DialogContent>
  )
}
