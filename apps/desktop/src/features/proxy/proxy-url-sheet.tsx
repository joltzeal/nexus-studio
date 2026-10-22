import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { copyText } from '@/lib/clipboard'
import { exportUrls } from './api'
import { SCHEMES, message, type Scheme } from './types'

export interface ProxyUrlSheetProps {
  ids: string[]
  /** Preselected protocol, e.g. when copied from a row action. */
  scheme?: Scheme | null
  /** Copy as soon as the URLs are generated (row action). */
  autoCopy?: boolean
  onOpenChange: (open: boolean) => void
  onCopied: (count: number) => void
}

export function ProxyUrlSheet({
  ids,
  scheme: initialScheme = null,
  autoCopy = false,
  onOpenChange,
  onCopied,
}: ProxyUrlSheetProps) {
  const [scheme, setScheme] = useState<string>(initialScheme ?? 'auto')
  const [urls, setUrls] = useState<string[]>([])
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  async function copy(text: string): Promise<boolean> {
    return copyText(text)
  }

  async function generate(thenCopy: boolean) {
    if (pending) return
    setPending(true)
    setError(null)
    setCopied(false)
    try {
      const data = await exportUrls(ids, scheme === 'auto' ? null : (scheme as Scheme))
      if (!alive.current) return
      setUrls(data.urls)
      if (thenCopy) {
        const ok = await copy(data.urls.join('\n'))
        if (!alive.current) return
        if (ok) {
          setCopied(true)
          onCopied(data.count)
        } else {
          setError('自动复制失败，请手动选择文本或使用复制按钮。')
        }
      }
    } catch (cause) {
      if (alive.current) setError(message(cause))
    } finally {
      if (alive.current) setPending(false)
    }
  }

  useEffect(() => {
    if (!autoCopy || started.current) return
    started.current = true
    void generate(true)
    // Only the first open should auto-copy; later protocol changes stay manual.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCopy])

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>复制代理 URL</SheetTitle>
          <SheetDescription>
            每条代理生成一个 URL，每行一条。URL
            只包含协议、主机、端口与用户名；密码保存在插件私有目录，宿主不读取也不代为拼接。
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <p className="proxy-result">已选中 {ids.length} 条代理</p>
          <Field>
            <FieldLabel htmlFor="url-scheme">复制协议</FieldLabel>
            <Select
              value={scheme}
              disabled={pending}
              onValueChange={(value) => {
                setScheme(value)
                setUrls([])
                setCopied(false)
                setError(null)
              }}
            >
              <SelectTrigger id="url-scheme">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">自动选择</SelectItem>
                {SCHEMES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              自动按 SOCKS5H、SOCKS5、HTTP、HTTPS
              顺序选择；指定协议时所有选中代理都须支持。
            </FieldDescription>
          </Field>
          <Button disabled={pending} onClick={() => void generate(true)}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : copied ? (
              <Check data-icon="inline-start" />
            ) : (
              <Copy data-icon="inline-start" />
            )}
            {pending ? '生成中…' : copied ? '已复制' : '生成并复制'}
          </Button>
          {error === null ? null : <FieldError role="alert">{error}</FieldError>}
          {urls.length === 0 ? null : (
            <>
              <div className="proxy-url-toolbar">
                <span className="proxy-result">共 {urls.length} 条</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void copy(urls.join('\n')).then((ok) => {
                      if (ok) {
                        setCopied(true)
                        onCopied(urls.length)
                      } else {
                        setError('复制失败，请手动选择文本。')
                      }
                    })
                  }}
                >
                  <Copy data-icon="inline-start" />
                  复制全部
                </Button>
              </div>
              <Textarea
                readOnly
                rows={12}
                spellCheck={false}
                aria-label="代理 URL 列表"
                className="font-mono text-xs"
                value={urls.join('\n')}
              />
            </>
          )}
        </SheetBody>
        <SheetFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
