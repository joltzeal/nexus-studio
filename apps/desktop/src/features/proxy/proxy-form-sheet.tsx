import { useState, type FormEvent } from 'react'
import { Loader2, Plus } from 'lucide-react'
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
import { Switch } from '@/components/ui/switch'
import { createGroup, createProxy, updateProxy, type ProxyInput } from './api'
import { parseProxyLink, type ParsedProxyLink } from './parse-proxy-link'
import { ProxySelect } from './proxy-select'
import { SCHEMES, message, type ProxyGroup, type ProxyRow, type Scheme } from './types'

type PasswordMode = 'keep' | 'replace' | 'clear'

const NO_GROUP = 'none'

export interface ProxyFormSheetProps {
  /** `null` creates a new proxy. The sheet is mounted only while it is open. */
  editing: ProxyRow | null
  groups: ProxyGroup[]
  onOpenChange: (open: boolean) => void
  /** Called after a successful save so the page can refetch and re-select groups. */
  onSaved: () => Promise<void>
}

export function ProxyFormSheet({
  editing,
  groups,
  onOpenChange,
  onSaved,
}: ProxyFormSheetProps) {
  const [name, setName] = useState(editing?.name ?? '')
  const [groupId, setGroupId] = useState<string>(editing?.groupId ?? NO_GROUP)
  const [schemes, setSchemes] = useState<Scheme[]>(editing?.schemes ?? ['http'])
  const [host, setHost] = useState(editing?.host ?? '')
  const [port, setPort] = useState(String(editing?.port ?? 8080))
  const [username, setUsername] = useState(editing?.username ?? '')
  const [password, setPassword] = useState('')
  const [passwordMode, setPasswordMode] = useState<PasswordMode>('keep')
  const [udp, setUdp] = useState(editing?.udp ?? true)
  const [enabled, setEnabled] = useState(editing?.enabled ?? true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newGroup, setNewGroup] = useState<string | null>(null)
  const [groupBusy, setGroupBusy] = useState(false)
  const [recognized, setRecognized] = useState<string | null>(null)

  /**
   * Fills the form from a pasted link. The password never appears in the
   * confirmation line — the page must not echo credentials.
   */
  function applyLink(parsed: ParsedProxyLink) {
    setSchemes([parsed.scheme])
    setHost(parsed.host)
    setPort(String(parsed.port))
    setUsername(parsed.username)
    setPassword(parsed.password)
    // A fresh form has no name yet; the host is a truthful default, not a guess
    // about the provider. Never overwrite a name the user already typed.
    if (name.trim() === '') setName(parsed.host)
    if (editing !== null) {
      setPasswordMode(parsed.password === '' ? 'keep' : 'replace')
    }
    const shape =
      parsed.format === 'userinfo' ? 'user:pass@host:port' : 'host:port:user:pass'
    setRecognized(
      `${parsed.scheme.toUpperCase()} · ${parsed.host}:${parsed.port} · ${
        parsed.username === '' ? '无认证信息' : '已填入用户名与密码'
      }（${shape} 格式）`,
    )
    setError(null)
  }

  function toggleScheme(scheme: Scheme, checked: boolean) {
    setSchemes((current) =>
      checked
        ? [...new Set([...current, scheme])]
        : current.filter((value) => value !== scheme),
    )
    setError(null)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending || groupBusy) return
    const trimmedName = name.trim()
    const trimmedHost = host.trim()
    const numericPort = Number(port)
    if (trimmedName === '') return setError('请输入名称。')
    if (schemes.length === 0) return setError('请至少选择一个协议。')
    if (trimmedHost === '') return setError('请输入主机地址。')
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      return setError('端口需要是 1 到 65535 之间的整数。')
    }
    if (editing !== null && passwordMode === 'replace' && password === '') {
      return setError('请输入新密码，或改为保留现有密码。')
    }
    const body: ProxyInput = {
      name: trimmedName,
      schemes,
      host: trimmedHost,
      port: numericPort,
      username: username.trim(),
      enabled,
      udp,
      groupId: groupId === NO_GROUP ? null : Number(groupId),
    }
    if (editing === null || passwordMode === 'replace') body.password = password
    if (passwordMode === 'clear') body.password = ''
    setPending(true)
    setError(null)
    try {
      if (editing === null) await createProxy(body)
      else await updateProxy(editing.id, body)
      await onSaved()
      onOpenChange(false)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setPending(false)
    }
  }

  async function addGroup() {
    const trimmed = (newGroup ?? '').trim()
    if (trimmed === '' || groupBusy) return
    setGroupBusy(true)
    setError(null)
    try {
      const group = await createGroup(trimmed)
      setGroupId(String(group.id))
      setNewGroup(null)
      await onSaved()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setGroupBusy(false)
    }
  }

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{editing === null ? '新增代理' : '编辑代理'}</SheetTitle>
          <SheetDescription>
            支持 HTTP、HTTPS、SOCKS5 与
            SOCKS5H。密码由插件写入自己的私有目录，读取时不会返回。
          </SheetDescription>
        </SheetHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
          <SheetBody>
            <div className="proxy-form-section">
              <h3>连接配置</h3>
              <Field>
                <FieldLabel htmlFor="proxy-name">名称</FieldLabel>
                <Input
                  id="proxy-name"
                  autoFocus
                  maxLength={128}
                  disabled={pending}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="proxy-group">代理分组</FieldLabel>
                <div className="proxy-group-row">
                  <ProxySelect
                    id="proxy-group"
                    ariaLabel="代理分组"
                    value={groupId}
                    disabled={pending || groupBusy}
                    onValueChange={setGroupId}
                    options={[
                      { value: NO_GROUP, label: '未分组' },
                      ...groups.map((group) => ({
                        value: String(group.id),
                        label: group.name,
                      })),
                    ]}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="新建分组"
                    disabled={pending || groupBusy}
                    onClick={() =>
                      setNewGroup((current) => (current === null ? '' : null))
                    }
                  >
                    <Plus data-icon="inline-start" />
                    分组
                  </Button>
                </div>
                {newGroup === null ? null : (
                  <div className="proxy-group-row">
                    <Input
                      aria-label="新分组名称"
                      maxLength={128}
                      placeholder="新分组名称"
                      disabled={groupBusy}
                      value={newGroup}
                      onChange={(event) => setNewGroup(event.target.value)}
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={groupBusy || newGroup.trim() === ''}
                      onClick={() => void addGroup()}
                    >
                      {groupBusy ? '创建中…' : '创建'}
                    </Button>
                  </div>
                )}
              </Field>
              <Field>
                <FieldLabel>支持协议</FieldLabel>
                <div className="proxy-scheme-picker">
                  {SCHEMES.map((scheme) => (
                    <label key={scheme}>
                      <Checkbox
                        checked={schemes.includes(scheme)}
                        disabled={pending}
                        onCheckedChange={(checked) =>
                          toggleScheme(scheme, checked === true)
                        }
                      />
                      {scheme.toUpperCase()}
                    </label>
                  ))}
                </div>
                <FieldDescription>
                  多个协议共用同一条连接记录；SOCKS5H 由代理解析域名。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="proxy-host">主机地址</FieldLabel>
                <Input
                  id="proxy-host"
                  maxLength={512}
                  placeholder="proxy.example.com，或粘贴整条代理链接"
                  disabled={pending}
                  value={host}
                  onChange={(event) => {
                    const value = event.target.value
                    const parsed = parseProxyLink(value)
                    if (parsed !== null) {
                      applyLink(parsed)
                      return
                    }
                    setHost(value)
                    setRecognized(null)
                  }}
                  onPaste={(event) => {
                    const parsed = parseProxyLink(event.clipboardData.getData('text'))
                    if (parsed === null) return
                    event.preventDefault()
                    applyLink(parsed)
                  }}
                />
                <FieldDescription>
                  填写域名、IPv4 或 IPv6，不包含协议与端口；IPv6 可带方括号。
                  也可以直接粘贴整条代理链接，会自动拆到协议、端口与认证信息。
                </FieldDescription>
                {recognized === null ? null : (
                  <p className="proxy-recognized" role="status">
                    {recognized}
                  </p>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="proxy-port">端口</FieldLabel>
                <Input
                  id="proxy-port"
                  inputMode="numeric"
                  disabled={pending}
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                />
              </Field>
            </div>
            <div className="proxy-form-section">
              <h3>认证信息</h3>
              <Field>
                <FieldLabel htmlFor="proxy-username">用户名</FieldLabel>
                <Input
                  id="proxy-username"
                  autoComplete="off"
                  maxLength={128}
                  disabled={pending}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Field>
              {editing === null ? null : (
                <Field>
                  <FieldLabel htmlFor="proxy-password-mode">密码处理</FieldLabel>
                  <ProxySelect
                    id="proxy-password-mode"
                    ariaLabel="密码处理"
                    value={passwordMode}
                    disabled={pending}
                    onValueChange={(value) => setPasswordMode(value as PasswordMode)}
                    options={[
                      { value: 'keep', label: '保留现有密码' },
                      { value: 'replace', label: '替换密码' },
                      { value: 'clear', label: '清除密码' },
                    ]}
                  />
                  <FieldDescription>
                    {editing.hasPassword
                      ? '已保存密码；保留时无需重新输入。'
                      : '当前未保存密码。'}
                  </FieldDescription>
                </Field>
              )}
              {editing === null || passwordMode === 'replace' ? (
                <Field>
                  <FieldLabel htmlFor="proxy-password">密码</FieldLabel>
                  <Input
                    id="proxy-password"
                    type="password"
                    autoComplete="new-password"
                    maxLength={512}
                    disabled={pending}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
              ) : null}
              <Field className="proxy-switch-field" orientation="horizontal">
                <FieldLabel htmlFor="proxy-udp">SOCKS UDP</FieldLabel>
                <Switch
                  id="proxy-udp"
                  checked={udp}
                  disabled={pending}
                  onCheckedChange={setUdp}
                />
              </Field>
              <Field className="proxy-switch-field" orientation="horizontal">
                <FieldLabel htmlFor="proxy-enabled">启用</FieldLabel>
                <Switch
                  id="proxy-enabled"
                  checked={enabled}
                  disabled={pending}
                  onCheckedChange={setEnabled}
                />
              </Field>
              <FieldDescription>
                UDP 只影响 Clash 订阅；联网检测仅验证 TCP。
              </FieldDescription>
            </div>
            {error === null ? null : <FieldError role="alert">{error}</FieldError>}
          </SheetBody>
          <SheetFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={pending || groupBusy}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {pending ? '保存中…' : '保存'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
