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
  BROWSER_PROVIDERS,
  listBrowserConnections,
  listBrowserProviderGroups,
  type BrowserConnection,
  type BrowserProviderId,
  type ProviderGroup,
  type SaveBrowserConnectionInput,
} from '@/lib/platform/browser-connections'
import {
  browserConnectionDefaults,
  connectBrowser,
} from '@/lib/platform/browser-connection-setup'

export function BrowserConnectionsPage() {
  const native = browserWindowsAvailable()
  const [connections, setConnections] = useState<BrowserConnection[]>([])
  const [editing, setEditing] = useState<
    BrowserConnection | 'adspower' | 'bitbrowser' | null
  >(null)
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
    setEditing(null)
  }
  return (
    <section className="collection-page" aria-label="浏览器接入设置">
      <div className="section-intro">
        <div>
          <h2 className="page-heading">浏览器接入</h2>
          <p className="page-description">
            内置浏览器可直接使用，也可连接本机已登录的其他浏览器。
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
          {BROWSER_PROVIDERS.filter((provider) => provider.id !== 'cloakbrowser').map(
            (provider) => (
              <Button
                key={provider.id}
                variant="outline"
                disabled={!native}
                onClick={() => setEditing(provider.id as 'adspower' | 'bitbrowser')}
              >
                连接 {provider.name}
              </Button>
            ),
          )}
        </div>
      </div>
      {!native ? <p role="status">请在 Raccoon 桌面应用中管理浏览器接入。</p> : null}
      {error ? <FieldError role="alert">{error}</FieldError> : null}
      <Table aria-label="浏览器接入">
        <TableHeader>
          <TableRow>
            <TableHead>浏览器</TableHead>
            <TableHead>连接名称</TableHead>
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
                  {connection.endpoint || '随 Raccoon 提供'}
                </small>
              </TableCell>
              <TableCell>
                <Badge variant={connection.enabled ? 'default' : 'secondary'}>
                  {connection.providerId === 'cloakbrowser'
                    ? '已内置'
                    : !connection.scopeConfirmed
                      ? '待连接'
                      : connection.enabled
                        ? '已连接'
                        : '未启用'}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                {connection.providerId !== 'cloakbrowser' ? (
                  <Button variant="outline" onClick={() => setEditing(connection)}>
                    {connection.scopeConfirmed && connection.enabled ? '设置' : '连接'}
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null)
            setAttempt((value) => value + 1)
          }
        }}
      >
        {editing === null ? null : (
          <BrowserConnectionEditor
            key={
              typeof editing === 'string' ? editing : `${editing.id}:${editing.revision}`
            }
            connection={typeof editing === 'string' ? null : editing}
            {...(typeof editing === 'string' ? { initialProvider: editing } : {})}
            onUpdated={updated}
            onClose={() => {
              setEditing(null)
              setAttempt((value) => value + 1)
            }}
          />
        )}
      </Dialog>
    </section>
  )
}

export function BrowserConnectionEditor({
  connection,
  initialProvider = 'adspower',
  onUpdated,
  onClose,
}: {
  connection: BrowserConnection | null
  initialProvider?: Exclude<BrowserProviderId, 'cloakbrowser'>
  onUpdated: (connection: BrowserConnection) => void
  onClose: () => void
}) {
  const [input, setInput] = useState<SaveBrowserConnectionInput>(() =>
    connection
      ? {
          id: connection.id,
          providerId: connection.providerId,
          name: connection.name,
          endpoint: connection.endpoint,
          apiKey: connection.apiKey,
          defaultGroupId: connection.defaultGroupId,
          scopeLabel: connection.scopeLabel,
        }
      : browserConnectionDefaults(initialProvider),
  )
  const [groups, setGroups] = useState<ProviderGroup[]>([])
  const [groupError, setGroupError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const busy = useRef(false)
  const generation = useRef(0)
  const remembered = useRef<BrowserConnection | null>(connection)
  useEffect(() => {
    generation.current += 1
    return () => {
      generation.current += 1
    }
  }, [connection?.id, connection?.revision])
  useEffect(() => {
    if (!advanced || !input.id) return
    let active = true
    void listBrowserProviderGroups(input.id).then(
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
  }, [advanced, input.id])

  function patch(changes: Partial<SaveBrowserConnectionInput>) {
    if (busy.current) return
    setInput((current) => ({ ...current, ...changes }))
    setError(null)
  }
  async function connect(event: FormEvent) {
    event.preventDefault()
    if (busy.current) return
    const request = generation.current
    busy.current = true
    setPending(true)
    setError(null)
    try {
      const saved = await connectBrowser(
        {
          ...input,
          ...(remembered.current ? { id: remembered.current.id } : {}),
          scopeLabel: remembered.current?.scopeLabel || input.name.trim(),
        },
        (saved) => {
          if (request !== generation.current) return
          remembered.current = saved
          setInput({
            id: saved.id,
            providerId: saved.providerId,
            name: saved.name,
            endpoint: saved.endpoint,
            apiKey: saved.apiKey,
            defaultGroupId: saved.defaultGroupId,
            scopeLabel: saved.scopeLabel,
          })
        },
        remembered.current,
      )
      if (request === generation.current) onUpdated(saved)
    } catch (cause) {
      if (request === generation.current) setError(browserError(cause).message)
    } finally {
      busy.current = false
      if (request === generation.current) setPending(false)
    }
  }
  return (
    <DialogContent
      className="window-editor"
      showCloseButton={!pending}
      onEscapeKeyDown={(event) => {
        if (pending) event.preventDefault()
      }}
      onInteractOutside={(event) => {
        if (pending) event.preventDefault()
      }}
    >
      <DialogHeader>
        <DialogTitle>连接浏览器</DialogTitle>
        <DialogDescription>
          在官方应用中登录并开启本机 API，然后点击连接。
        </DialogDescription>
      </DialogHeader>
      <form id="browser-connection-form" onSubmit={(event) => void connect(event)}>
        <FieldGroup>
          <Field>
            <FieldLabel>浏览器</FieldLabel>
            <Select
              value={input.providerId}
              disabled={pending || !!input.id}
              onValueChange={(value) => {
                if (value === 'adspower' || value === 'bitbrowser') {
                  setInput(browserConnectionDefaults(value))
                  setGroups([])
                  setGroupError(null)
                  setError(null)
                }
              }}
            >
              <SelectTrigger aria-label="浏览器提供方">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BROWSER_PROVIDERS.filter((row) => row.id !== 'cloakbrowser').map(
                  (row) => (
                    <SelectItem key={row.id} value={row.id}>
                      {row.name}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </Field>
          {input.providerId === 'adspower' ? (
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
          ) : null}
          <details
            className="rounded-md border px-3 py-2 text-sm"
            open={advanced}
            onToggle={(event) => setAdvanced(event.currentTarget.open)}
          >
            <summary className="cursor-pointer text-muted-foreground">更多设置</summary>
            <FieldGroup className="mt-3">
              <Field>
                <FieldLabel htmlFor="connection-name">连接名称</FieldLabel>
                <Input
                  id="connection-name"
                  required
                  maxLength={80}
                  value={input.name}
                  disabled={pending}
                  onChange={(event) => patch({ name: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="connection-endpoint">本机 API 地址</FieldLabel>
                <Input
                  id="connection-endpoint"
                  required
                  value={input.endpoint}
                  disabled={pending}
                  onChange={(event) => patch({ endpoint: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel>默认浏览器分组</FieldLabel>
                <Select
                  value={input.defaultGroupId ?? '__none'}
                  disabled={pending || !input.id}
                  onValueChange={(value) =>
                    patch({ defaultGroupId: value === '__none' ? null : value })
                  }
                >
                  <SelectTrigger aria-label="官方目标分组">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">默认分组</SelectItem>
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
                {groupError ? <FieldDescription>{groupError}</FieldDescription> : null}
              </Field>
            </FieldGroup>
          </details>
          {error ? <FieldError role="alert">{error}</FieldError> : null}
        </FieldGroup>
      </form>
      <DialogFooter>
        <Button variant="ghost" disabled={pending} onClick={onClose}>
          取消
        </Button>
        <Button type="submit" form="browser-connection-form" disabled={pending}>
          {pending ? '连接中…' : '连接并启用'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
