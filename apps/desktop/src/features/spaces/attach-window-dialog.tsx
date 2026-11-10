import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  attachBrowserWindows,
  discoverBrowserProfiles,
  type BrowserConnection,
  type RemoteProfile,
} from '@/lib/platform/browser-connections'
import { browserError } from '@/lib/platform/browser-api'
import type { BrowserWindow } from '@/lib/platform/windows'
import { toggleSelection } from './transfer-state'

export function AttachWindowDialog({
  connection,
  onAttached,
  onClose,
}: {
  connection: BrowserConnection
  onAttached: (windows: BrowserWindow[]) => void
  onClose: () => void
}) {
  const [profiles, setProfiles] = useState<RemoteProfile[]>([])
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const request = useRef(0)
  const submitting = useRef(false)
  const ready = useRef(false)
  const connectionKey = `${connection.id}:${connection.revision}`
  const scope = useRef(connectionKey)
  const loadKey = `${connectionKey}:${attempt}`
  const loading = loadedKey !== loadKey

  useEffect(() => {
    const generation = ++request.current
    scope.current = connectionKey
    ready.current = false
    void discoverBrowserProfiles(connection.id).then(
      (items) => {
        if (generation !== request.current) return
        setProfiles(items)
        ready.current = true
        setSelection(new Set())
        setError(null)
        setLoadedKey(loadKey)
      },
      (cause: unknown) => {
        if (generation !== request.current) return
        setError(browserError(cause).message)
        setProfiles([])
        setSelection(new Set())
        setLoadedKey(loadKey)
      },
    )
    return () => {
      request.current += 1
    }
  }, [connection.id, connectionKey, loadKey])

  async function attach() {
    if (
      submitting.current ||
      !ready.current ||
      scope.current !== connectionKey ||
      loading ||
      !connection.capabilities.attach
    )
      return
    const ids = profiles
      .filter((profile) => selection.has(profile.id))
      .map((row) => row.id)
    if (ids.length === 0) return
    const generation = request.current
    submitting.current = true
    setPending(true)
    setError(null)
    try {
      const windows = await attachBrowserWindows(connection.id, ids)
      if (generation !== request.current) return
      onAttached(windows)
      onClose()
    } catch (cause) {
      if (generation === request.current) setError(browserError(cause).message)
    } finally {
      submitting.current = false
      if (generation === request.current) setPending(false)
    }
  }

  const visible = profiles.filter((row) =>
    `${row.name} ${row.id}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
  return (
    <DialogContent className="window-editor" showCloseButton={!pending}>
      <DialogHeader>
        <DialogTitle>接入已有窗口</DialogTitle>
        <DialogDescription>
          {connection.name} · 选择官方浏览器中已有的环境。接入后沿用其代理和指纹设置。
        </DialogDescription>
      </DialogHeader>
      <Input
        aria-label="搜索已有环境"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {loading ? (
        <p role="status">正在读取全部可见环境…</p>
      ) : (
        <div className="max-h-96 overflow-auto">
          <Table aria-label="可接入环境">
            <TableHeader>
              <TableRow>
                <TableHead>选择</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>环境 ID</TableHead>
                <TableHead>内核</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((profile) => (
                <TableRow key={profile.id}>
                  <TableCell>
                    <Checkbox
                      aria-label={`接入 ${profile.name}`}
                      checked={selection.has(profile.id)}
                      disabled={pending}
                      onCheckedChange={(checked) =>
                        setSelection((current) =>
                          toggleSelection(current, [profile.id], checked === true),
                        )
                      }
                    />
                  </TableCell>
                  <TableCell>{profile.name}</TableCell>
                  <TableCell>{profile.id}</TableCell>
                  <TableCell>{profile.kernelVersion ?? '未知'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">没有可见的匹配环境。</p>
          ) : null}
        </div>
      )}
      {error ? <FieldError role="alert">{error}</FieldError> : null}
      <DialogFooter>
        <Button variant="ghost" disabled={pending} onClick={onClose}>
          取消
        </Button>
        <Button
          variant="outline"
          disabled={loading || pending}
          onClick={() => {
            ready.current = false
            request.current += 1
            setSelection(new Set())
            setAttempt((value) => value + 1)
          }}
        >
          重新读取
        </Button>
        <Button
          disabled={loading || pending || selection.size === 0}
          onClick={() => void attach()}
        >
          {pending ? '正在接入…' : `接入 ${selection.size} 个窗口`}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
