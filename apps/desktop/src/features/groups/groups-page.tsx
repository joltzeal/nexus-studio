import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  createGroup,
  deleteGroup,
  listGroups,
  nativeGroupsAvailable,
  updateGroup,
  type WindowGroup,
} from '@/lib/platform/native-groups'
import { listNativeProfiles, type NativeProfile } from '@/lib/platform/native-profiles'

function message(cause: unknown): string {
  return typeof cause === 'string'
    ? cause
    : cause instanceof Error
      ? cause.message
      : '操作失败，请重试。'
}

export function GroupsPage() {
  const native = nativeGroupsAvailable()
  const [groups, setGroups] = useState<WindowGroup[]>([])
  const [windows, setWindows] = useState<NativeProfile[]>([])
  const [editing, setEditing] = useState<WindowGroup | 'new' | null>(null)
  const [viewing, setViewing] = useState<WindowGroup | null>(null)
  const [deleting, setDeleting] = useState<WindowGroup | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    const [nextGroups, nextWindows] = await Promise.all([
      listGroups(),
      listNativeProfiles(),
    ])
    setGroups(nextGroups)
    setWindows(nextWindows)
  }, [])

  useEffect(() => {
    if (!native) return
    let active = true
    void Promise.all([listGroups(), listNativeProfiles()]).then(
      ([nextGroups, nextWindows]) => {
        if (!active) return
        setGroups(nextGroups)
        setWindows(nextWindows)
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [native])

  async function save(name: string, note: string) {
    if (editing === null) return
    if (editing === 'new') await createGroup(name, note)
    else await updateGroup(editing.id, name, note)
    await load()
    setEditing(null)
  }

  async function remove() {
    if (!deleting) return
    setBusy(true)
    setError(null)
    try {
      await deleteGroup(deleting.id)
      await load()
      setDeleting(null)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="collection-page page-reveal" aria-labelledby="groups-heading">
      <div className="section-intro">
        <div>
          <h1 className="page-heading" id="groups-heading">
            分组管理
          </h1>
          <p className="page-description">整理窗口，快速找到常用的店铺。</p>
        </div>
        <Button disabled={!native} onClick={() => setEditing('new')}>
          <Plus data-icon="inline-start" />
          新建分组
        </Button>
      </div>
      {!native ? <p className="native-profiles-hint">请在桌面应用中管理分组。</p> : null}
      {error ? <FieldError role="alert">{error}</FieldError> : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {groups.map((group) => (
          <Card key={group.id}>
            <CardHeader className="pb-2">
              <CardTitle>{group.name}</CardTitle>
              <p className="text-sm text-muted-foreground">{group.windowCount} 个窗口</p>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="min-h-5 text-sm text-muted-foreground">
                {group.note || '无备注'}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setViewing(group)}>
                  查看窗口
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setEditing(group)}>
                  <Pencil data-icon="inline-start" />
                  编辑
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDeleting(group)}>
                  <Trash2 data-icon="inline-start" />
                  删除
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {native && groups.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>还没有分组</EmptyTitle>
            <EmptyDescription>新建分组后，可在窗口编辑页选择归属。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        {editing ? (
          <GroupEditor
            key={editing === 'new' ? 'new' : editing.id}
            group={editing === 'new' ? null : editing}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
        ) : null}
      </Dialog>
      <Dialog
        open={viewing !== null}
        onOpenChange={(open) => {
          if (!open) setViewing(null)
        }}
      >
        {viewing ? (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{viewing.name}</DialogTitle>
              <DialogDescription>
                {viewing.note || `${viewing.windowCount} 个窗口`}
              </DialogDescription>
            </DialogHeader>
            <ul className="space-y-2 text-sm">
              {windows
                .filter((window) => window.groupId === viewing.id)
                .map((window) => (
                  <li key={window.id} className="flex justify-between border-b pb-2">
                    <span>{window.name}</span>
                    <span className="text-muted-foreground">
                      {window.settings.platform}
                    </span>
                  </li>
                ))}
            </ul>
            {viewing.windowCount === 0 ? (
              <p className="text-sm text-muted-foreground">暂无窗口</p>
            ) : null}
            <DialogFooter>
              <Button onClick={() => setViewing(null)}>关闭</Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除分组「{deleting?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              分组内的窗口会变成未分组，窗口和浏览器数据不会删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void remove()
              }}
            >
              删除分组
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function GroupEditor({
  group,
  onSave,
  onCancel,
}: {
  group: WindowGroup | null
  onSave: (name: string, note: string) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(group?.name ?? '')
  const [note, setNote] = useState(group?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setError('请输入分组名称。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSave(name.trim(), note.trim())
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{group ? '编辑分组' : '新建分组'}</DialogTitle>
        <DialogDescription>按店铺、平台或用途整理窗口。</DialogDescription>
      </DialogHeader>
      <form
        id="group-form"
        className="grid gap-3"
        onSubmit={(event) => void submit(event)}
      >
        <Field>
          <FieldLabel htmlFor="group-name">名称</FieldLabel>
          <Input
            id="group-name"
            autoFocus
            maxLength={40}
            disabled={busy}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="group-note">备注</FieldLabel>
          <Input
            id="group-note"
            maxLength={120}
            disabled={busy}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        {error ? <FieldError role="alert">{error}</FieldError> : null}
      </form>
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" form="group-form" disabled={busy}>
          {busy ? '正在保存…' : '保存分组'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
