import { useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { generateDecodo, importProxies } from './api'
import { ProxySelect } from './proxy-select'
import { SCHEMES, message, type BatchResult, type ProxyGroup, type Scheme } from './types'

const NO_GROUP = 'none'
const MAX_BATCH = 1000

export interface ProxyBatchSheetProps {
  groups: ProxyGroup[]
  onOpenChange: (open: boolean) => void
  onImported: () => Promise<void>
}

export function ProxyBatchSheet({
  groups,
  onOpenChange,
  onImported,
}: ProxyBatchSheetProps) {
  const [mode, setMode] = useState<'urls' | 'decodo'>('urls')
  const [urls, setUrls] = useState('')
  const [groupId, setGroupId] = useState(NO_GROUP)
  const [host, setHost] = useState('dc.decodo.com')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [startPort, setStartPort] = useState('10001')
  const [endPort, setEndPort] = useState('10010')
  const [schemes, setSchemes] = useState<Scheme[]>(['http'])
  const [udp, setUdp] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BatchResult | null>(null)

  const count = Number(endPort) - Number(startPort) + 1
  const decodoValid =
    host.trim() !== '' &&
    username.trim() !== '' &&
    password !== '' &&
    schemes.length > 0 &&
    Number.isInteger(count) &&
    count >= 1 &&
    count <= MAX_BATCH

  function reset() {
    setResult(null)
    setError(null)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    reset()
    if (mode === 'urls' && urls.trim() === '') return setError('请粘贴至少一条代理 URL。')
    if (mode === 'decodo' && !decodoValid) {
      return setError('请填写主机、用户名、密码与协议，端口范围最多 1000 条。')
    }
    setPending(true)
    try {
      const target = groupId === NO_GROUP ? null : Number(groupId)
      const data =
        mode === 'urls'
          ? await importProxies(urls, target)
          : await generateDecodo({
              host: host.trim(),
              username: username.trim(),
              password,
              startPort: Number(startPort),
              endPort: Number(endPort),
              schemes,
              udp,
              groupId: target,
            })
      setResult(data)
      setUrls('')
      setPassword('')
      await onImported()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>批量添加代理</SheetTitle>
          <SheetDescription>
            相同主机、端口与认证信息只保存一条记录，协议自动合并。
          </SheetDescription>
        </SheetHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
          <SheetBody>
            <Tabs
              value={mode}
              onValueChange={(value) => {
                setMode(value === 'decodo' ? 'decodo' : 'urls')
                reset()
              }}
            >
              <TabsList>
                <TabsTrigger value="urls" disabled={pending}>
                  URL 导入
                </TabsTrigger>
                <TabsTrigger value="decodo" disabled={pending}>
                  Decodo
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Field>
              <FieldLabel htmlFor="batch-group">代理分组</FieldLabel>
              <ProxySelect
                id="batch-group"
                ariaLabel="代理分组"
                value={groupId}
                disabled={pending}
                onValueChange={setGroupId}
                options={[
                  { value: NO_GROUP, label: '未分组' },
                  ...groups.map((group) => ({
                    value: String(group.id),
                    label: group.name,
                  })),
                ]}
              />
              <FieldDescription>
                分组只应用于新代理；重复配置保留原分组。
              </FieldDescription>
            </Field>
            {mode === 'urls' ? (
              <Field>
                <FieldLabel htmlFor="batch-urls">代理 URL 列表</FieldLabel>
                <Textarea
                  id="batch-urls"
                  rows={10}
                  maxLength={500_000}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={pending}
                  className="font-mono text-xs"
                  placeholder={'socks5://user:pass@host:1080\nhttp://host:8080'}
                  value={urls}
                  onChange={(event) => setUrls(event.target.value)}
                />
                <FieldDescription>
                  每行一条完整 URL，支持不同协议、主机与认证信息；单次最多 1000 条。
                </FieldDescription>
              </Field>
            ) : (
              <>
                <div className="proxy-form-grid">
                  <Field>
                    <FieldLabel htmlFor="decodo-host">主机</FieldLabel>
                    <Input
                      id="decodo-host"
                      disabled={pending}
                      value={host}
                      onChange={(event) => setHost(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="decodo-user">用户名</FieldLabel>
                    <Input
                      id="decodo-user"
                      autoComplete="off"
                      disabled={pending}
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                    />
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="decodo-password">密码</FieldLabel>
                  <Input
                    id="decodo-password"
                    type="password"
                    autoComplete="new-password"
                    disabled={pending}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <FieldDescription>
                    密码写入插件私有目录，不随 RPC 返回。
                  </FieldDescription>
                </Field>
                <div className="proxy-form-grid">
                  <Field>
                    <FieldLabel htmlFor="decodo-start">起始端口</FieldLabel>
                    <Input
                      id="decodo-start"
                      inputMode="numeric"
                      disabled={pending}
                      value={startPort}
                      onChange={(event) => setStartPort(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="decodo-end">结束端口</FieldLabel>
                    <Input
                      id="decodo-end"
                      inputMode="numeric"
                      disabled={pending}
                      value={endPort}
                      onChange={(event) => setEndPort(event.target.value)}
                    />
                  </Field>
                </div>
                <Field>
                  <FieldLabel>协议</FieldLabel>
                  <div className="proxy-scheme-picker">
                    {SCHEMES.map((scheme) => (
                      <label key={scheme}>
                        <Checkbox
                          checked={schemes.includes(scheme)}
                          disabled={pending}
                          onCheckedChange={(checked) =>
                            setSchemes((current) =>
                              checked === true
                                ? [...new Set([...current, scheme])]
                                : current.filter((value) => value !== scheme),
                            )
                          }
                        />
                        {scheme.toUpperCase()}
                      </label>
                    ))}
                  </div>
                </Field>
                <Field className="proxy-switch-field" orientation="horizontal">
                  <FieldLabel htmlFor="decodo-udp">SOCKS UDP</FieldLabel>
                  <Switch
                    id="decodo-udp"
                    checked={udp}
                    disabled={pending}
                    onCheckedChange={setUdp}
                  />
                </Field>
                <p className="proxy-detail-note">
                  将生成 {Number.isFinite(count) && count > 0 ? count : 0} 条代理（上限
                  {MAX_BATCH}）。
                </p>
              </>
            )}
            {error === null ? null : <FieldError role="alert">{error}</FieldError>}
            {result === null ? null : (
              <p className="proxy-result" role="status">
                处理 {result.requested} 条，新增 {result.created} 条，合并协议{' '}
                {result.merged} 条，跳过 {result.duplicates} 条重复配置。
              </p>
            )}
          </SheetBody>
          <SheetFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              关闭
            </Button>
            <Button
              type="submit"
              disabled={pending || (mode === 'decodo' && !decodoValid)}
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {pending ? '保存中…' : mode === 'urls' ? '解析并保存' : '生成并保存'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
