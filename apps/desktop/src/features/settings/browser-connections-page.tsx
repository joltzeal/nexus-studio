import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { browserWindowsAvailable } from '@/lib/platform/windows'
import { browserError } from '@/lib/platform/browser-api'
import {
  activateBrowserConnection,
  BROWSER_PROVIDERS,
  confirmBrowserConnection,
  listBrowserConnections,
  listBrowserProviderGroups,
  probeBrowserConnection,
  saveBrowserConnection,
  type BrowserConnection,
  type BrowserConnectionProbe,
  type BrowserProviderId,
  type ProviderGroup,
  type SaveBrowserConnectionInput,
} from '@/lib/platform/browser-connections'

export function BrowserConnectionsPage() {
  const native = browserWindowsAvailable()
  const [connections, setConnections] = useState<BrowserConnection[]>([])
  const [editing, setEditing] = useState<BrowserConnection | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const listRequest = useRef(0)
  useEffect(() => {
    if (!native) return
    let active = true
    const request = ++listRequest.current
    void listBrowserConnections().then(
      (items) => {
        if (active && request === listRequest.current) {
          setConnections(items)
          setError(null)
        }
      },
      (cause: unknown) => {
        if (active && request === listRequest.current)
          setError(browserError(cause).message)
      },
    )
    return () => {
      active = false
    }
  }, [native, attempt])
  function updated(saved: BrowserConnection) {
    listRequest.current += 1
    setConnections((current) => [
      ...current
        .filter((row) => row.id !== saved.id)
        .map((row) =>
          saved.enabled && row.providerId === saved.providerId
            ? { ...row, enabled: false }
            : row,
        ),
      saved,
    ])
    setEditing(saved)
  }
  return (
    <section className="collection-page" aria-label="浏览器接入设置">
      <div className="section-intro">
        <div>
          <h2 className="page-heading">浏览器接入</h2>
          <p className="page-description">
            每种浏览器启用一个账户或工作区接入；历史接入保留原窗口绑定。
          </p>
        </div>
        <div className="section-actions">
          <Button
            variant="outline"
            disabled={!native}
            onClick={() => setAttempt((value) => value + 1)}
          >
            刷新
          </Button>
          <Button disabled={!native} onClick={() => setEditing('new')}>
            新增接入
          </Button>
        </div>
      </div>
      {!native ? <p role="status">请在 Nexus 桌面应用中管理浏览器接入。</p> : null}
      {error ? <FieldError role="alert">{error}</FieldError> : null}
      <Table aria-label="浏览器接入">
        <TableHeader>
          <TableRow>
            <TableHead>浏览器</TableHead>
            <TableHead>名称 / 作用域</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {connections.map((connection) => (
            <TableRow key={connection.id}>
              <TableCell>
                {BROWSER_PROVIDERS.find((row) => row.id === connection.providerId)?.name}
              </TableCell>
              <TableCell>
                {connection.name}
                <small className="block text-muted-foreground">
                  {connection.scopeLabel || '作用域未确认'}
                </small>
              </TableCell>
              <TableCell>
                <Badge variant={connection.enabled ? 'default' : 'secondary'}>
                  {connection.enabled
                    ? '已启用'
                    : connection.scopeConfirmed
                      ? '未启用'
                      : '待确认作用域'}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <Button variant="outline" onClick={() => setEditing(connection)}>
                  管理接入
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        {editing === null ? null : (
          <BrowserConnectionEditor
            key={editing === 'new' ? 'new' : `${editing.id}:${editing.revision}`}
            connection={editing === 'new' ? null : editing}
            onUpdated={updated}
            onClose={() => setEditing(null)}
          />
        )}
      </Dialog>
    </section>
  )
}

export function BrowserConnectionEditor({
  connection,
  onUpdated,
  onClose,
}: {
  connection: BrowserConnection | null
  onUpdated: (connection: BrowserConnection) => void
  onClose: () => void
}) {
  const [input, setInput] = useState<SaveBrowserConnectionInput>(() => ({
    ...(connection ? { id: connection.id } : {}),
    providerId: connection?.providerId ?? 'adspower',
    name: connection?.name ?? '',
    endpoint: connection?.endpoint ?? '',
    apiKey: connection?.apiKey ?? null,
    defaultGroupId: connection?.defaultGroupId ?? null,
    scopeLabel: connection?.scopeLabel ?? '',
  }))
  const [dirty, setDirty] = useState(false)
  const [probe, setProbe] = useState<BrowserConnectionProbe | null>(null)
  const [groups, setGroups] = useState<ProviderGroup[]>([])
  const [groupError, setGroupError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [groupAttempt, setGroupAttempt] = useState(0)
  const busy = useRef(false)
  const dirtyRef = useRef(false)
  const generation = useRef(0)
  useEffect(() => {
    generation.current += 1
    return () => {
      generation.current += 1
    }
  }, [connection?.id, connection?.revision])
  const savedConnectionId = connection?.id
  const savedProviderId = connection?.providerId
  useEffect(() => {
    if (!savedConnectionId || savedProviderId === 'cloakbrowser') return
    let active = true
    void listBrowserProviderGroups(savedConnectionId).then(
      (items) => {
        if (active) {
          setGroups(items)
          setGroupError(null)
        }
      },
      (cause: unknown) => {
        if (active) setGroupError(browserError(cause).message)
      },
    )
    return () => {
      active = false
    }
  }, [savedConnectionId, savedProviderId, connection?.revision, groupAttempt])

  function patch(changes: Partial<SaveBrowserConnectionInput>) {
    if (busy.current) return
    dirtyRef.current = true
    setInput((current) => ({ ...current, ...changes }))
    setDirty(true)
    setProbe(null)
    setError(null)
  }
  async function run(action: () => Promise<void>) {
    if (busy.current) return
    const request = generation.current
    busy.current = true
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      if (request === generation.current) setError(browserError(cause).message)
    } finally {
      busy.current = false
      if (request === generation.current) setPending(false)
    }
  }
  const builtin = input.providerId === 'cloakbrowser'
  async function save(event: FormEvent) {
    event.preventDefault()
    const request = generation.current
    await run(async () => {
      const saved = await saveBrowserConnection(input)
      if (request !== generation.current) return
      dirtyRef.current = false
      setDirty(false)
      setProbe(null)
      onUpdated(saved)
    })
  }
  async function check() {
    if (!connection || dirtyRef.current) return
    const request = generation.current
    await run(async () => {
      const result = await probeBrowserConnection(connection.id)
      if (request !== generation.current) return
      setProbe(result)
      if (result.connected) setGroupAttempt((value) => value + 1)
    })
  }
  async function confirm() {
    if (!connection || dirtyRef.current || !probe?.connected || !input.scopeLabel.trim())
      return
    const request = generation.current
    await run(async () => {
      const saved = await confirmBrowserConnection(connection.id, input.scopeLabel.trim())
      if (request === generation.current) onUpdated(saved)
    })
  }
  async function activate() {
    if (!connection?.scopeConfirmed || dirtyRef.current) return
    const request = generation.current
    await run(async () => {
      const saved = await activateBrowserConnection(connection.id)
      if (request === generation.current) onUpdated(saved)
    })
  }
  return (
    <DialogContent className="window-editor" showCloseButton={!pending}>
      <DialogHeader>
        <DialogTitle>浏览器接入</DialogTitle>
        <DialogDescription>
          请先安装、登录官方浏览器并启用本机 API。接入密钥按当前桌面存储方式明文保存。
        </DialogDescription>
      </DialogHeader>
      <form id="browser-connection-form" onSubmit={(event) => void save(event)}>
        <FieldGroup>
          <Field>
            <FieldLabel>浏览器</FieldLabel>
            <Select
              value={input.providerId}
              disabled={pending || connection !== null}
              onValueChange={(value) =>
                patch({ providerId: value as BrowserProviderId, defaultGroupId: null })
              }
            >
              <SelectTrigger aria-label="浏览器提供方">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BROWSER_PROVIDERS.filter(
                  (row) => connection || row.id !== 'cloakbrowser',
                ).map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="connection-name">接入名称</FieldLabel>
            <Input
              id="connection-name"
              required
              value={input.name}
              disabled={pending}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </Field>
          {!builtin ? (
            <>
              <Field>
                <FieldLabel htmlFor="connection-endpoint">本机 API 地址</FieldLabel>
                <Input
                  id="connection-endpoint"
                  required
                  value={input.endpoint}
                  disabled={pending}
                  placeholder="官方应用显示的本机 API 地址"
                  onChange={(event) => patch({ endpoint: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="connection-key">API Key（可选）</FieldLabel>
                <Input
                  id="connection-key"
                  type="password"
                  autoComplete="off"
                  value={input.apiKey ?? ''}
                  disabled={pending}
                  onChange={(event) => patch({ apiKey: event.target.value || null })}
                />
              </Field>
              <Field>
                <FieldLabel>新建环境的官方分组</FieldLabel>
                <Select
                  value={input.defaultGroupId ?? '__none'}
                  disabled={pending || !connection}
                  onValueChange={(value) =>
                    patch({ defaultGroupId: value === '__none' ? null : value })
                  }
                >
                  <SelectTrigger aria-label="官方目标分组">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">不指定分组</SelectItem>
                    {input.defaultGroupId &&
                    !groups.some((row) => row.id === input.defaultGroupId) ? (
                      <SelectItem value={input.defaultGroupId}>
                        {input.defaultGroupId}（已保存）
                      </SelectItem>
                    ) : null}
                    {groups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  从官方 API 读取，与 Nexus 的业务分组独立。
                </FieldDescription>
                {groupError ? (
                  <FieldError>
                    {groupError}
                    <Button
                      type="button"
                      variant="link"
                      disabled={pending}
                      onClick={() => setGroupAttempt((value) => value + 1)}
                    >
                      重读分组
                    </Button>
                  </FieldError>
                ) : null}
              </Field>
            </>
          ) : null}
          <Field>
            <FieldLabel htmlFor="connection-scope">账户 / 工作区名称</FieldLabel>
            <Input
              id="connection-scope"
              value={input.scopeLabel}
              disabled={pending}
              onChange={(event) => patch({ scopeLabel: event.target.value })}
            />
            <FieldDescription>
              切换官方账户时请新建接入，已有窗口的作用域绑定保持固定。
            </FieldDescription>
          </Field>
          {dirty ? (
            <p className="text-xs text-muted-foreground">
              配置已更改，请先保存，再检测和确认当前账户作用域。
            </p>
          ) : null}
          {probe ? (
            <p role="status">
              {probe.message}
              {probe.scopeId
                ? ` · 作用域 ${probe.scopeId}`
                : ' · 官方未提供作用域 ID，请人工核对账户 / 工作区名称'}
            </p>
          ) : null}
          {error ? <FieldError role="alert">{error}</FieldError> : null}
        </FieldGroup>
      </form>
      <DialogFooter className="flex-wrap">
        <Button variant="ghost" disabled={pending} onClick={onClose}>
          关闭
        </Button>
        <Button
          variant="outline"
          disabled={pending || dirty || !connection}
          onClick={() => void check()}
        >
          检测连接
        </Button>
        <Button
          variant="outline"
          disabled={pending || dirty || !probe?.connected || !input.scopeLabel.trim()}
          onClick={() => void confirm()}
        >
          确认作用域
        </Button>
        <Button
          variant="outline"
          disabled={pending || dirty || !connection?.scopeConfirmed || connection.enabled}
          onClick={() => void activate()}
        >
          启用此接入
        </Button>
        <Button type="submit" form="browser-connection-form" disabled={pending}>
          保存配置
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
