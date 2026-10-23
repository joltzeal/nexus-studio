import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  getNetworkProxy,
  nativeNetworkProxyAvailable,
  setNetworkProxy,
  type NetworkProxy,
  type ProxyMode,
} from '@/lib/platform/native-network-proxy'

const options: { mode: ProxyMode; label: string }[] = [
  { mode: 'direct', label: '不代理' },
  { mode: 'system', label: '系统代理' },
  { mode: 'manual', label: '手动代理' },
]

function message(error: unknown): string {
  return typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '无法保存代理设置'
}

export function NetworkProxyPage() {
  const native = nativeNetworkProxyAvailable()
  const [value, setValue] = useState<NetworkProxy>({ mode: 'direct', url: null })
  const [loading, setLoading] = useState(native)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!native) return
    let active = true
    void getNetworkProxy()
      .then(
        (next) => {
          if (active) setValue(next)
        },
        (cause: unknown) => {
          if (active) setError(message(cause))
        },
      )
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [native])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const next = await setNetworkProxy(value)
      setValue(next)
      setSaved(true)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      className="settings-page page-reveal"
      aria-labelledby="network-proxy-heading"
    >
      <h1 className="page-heading" id="network-proxy-heading">
        应用代理
      </h1>
      <p className="page-description">
        用于应用请求和插件的常规网络请求。单个窗口的浏览器代理在窗口配置中设置。
      </p>
      <Card>
        <CardHeader>
          <CardTitle>连接方式</CardTitle>
        </CardHeader>
        <CardContent>
          {native ? (
            <form id="network-proxy-form" onSubmit={(event) => void submit(event)}>
              <Field data-invalid={!!error}>
                <FieldLabel htmlFor="network-proxy-mode">代理模式</FieldLabel>
                <Select
                  disabled={loading || saving}
                  value={value.mode}
                  onValueChange={(mode) => {
                    if (!mode) return
                    setValue((current) => ({
                      ...current,
                      mode: mode as ProxyMode,
                    }))
                    setSaved(false)
                    setError(null)
                  }}
                >
                  <SelectTrigger id="network-proxy-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((option) => (
                      <SelectItem key={option.mode} value={option.mode}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {value.mode === 'manual' ? (
                  <>
                    <FieldLabel htmlFor="network-proxy-url">代理地址</FieldLabel>
                    <Input
                      id="network-proxy-url"
                      value={value.url ?? ''}
                      disabled={loading || saving}
                      spellCheck={false}
                      placeholder="socks5://127.0.0.1:7890"
                      onChange={(event) => {
                        setValue((current) => ({ ...current, url: event.target.value }))
                        setSaved(false)
                        setError(null)
                      }}
                    />
                    <FieldDescription>
                      支持 http、https 和 socks5，填写主机及端口。
                    </FieldDescription>
                  </>
                ) : null}
                {error ? <FieldError role="alert">{error}</FieldError> : null}
              </Field>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">请在桌面应用中设置代理。</p>
          )}
        </CardContent>
        {native ? (
          <CardFooter className="justify-between gap-4">
            <span role="status" className="text-sm text-muted-foreground">
              {loading ? '正在读取…' : saved ? '已保存，插件进程正在重新连接' : ''}
            </span>
            <Button type="submit" form="network-proxy-form" disabled={loading || saving}>
              {saving ? '正在保存…' : '保存代理设置'}
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </section>
  )
}
