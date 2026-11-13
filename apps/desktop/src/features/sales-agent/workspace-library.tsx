import { useEffect, useState } from 'react'
import type { AgentWorkspaceEntry, AgentWorkspaceSave } from '@nexus/plugin-sdk/agent'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LabeledSelect } from '@/components/ui/labeled-select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  agentError,
  deleteAgentWorkspace,
  getAgentWorkspace,
  listAgentTargets,
  listAgentWorkspaces,
  readPickedProducts,
  saveAgentWorkspace,
} from './api'
import { AgentPagination } from './agent-pagination'
import type { AgentDraft } from './assignment'
import { RequestScope } from './state'
import { useAgentQuery } from './use-query'
import { draftFromPlan, planFromDraft, workspaceSaveOutcome } from './workspace-state'

export function WorkspaceLibrary({
  draft,
  locked,
  onLoaded,
  onLockChange,
}: {
  draft: AgentDraft
  locked: boolean
  onLoaded: (draft: AgentDraft) => void
  onLockChange: (locked: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<'draft' | 'template'>('draft')
  const [name, setName] = useState('')
  const [active, setActive] = useState<AgentWorkspaceEntry | null>(null)
  const [pending, setPending] = useState<AgentWorkspaceSave | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [attempt, setAttempt] = useState(0)
  const [loadId, setLoadId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{
    id: string
    revision: number
    name: string
  } | null>(null)
  const [scope] = useState(() => new RequestScope())
  useEffect(() => () => scope.invalidate(), [scope])
  useEffect(() => {
    onLockChange(busy || pending !== null)
    return () => onLockChange(false)
  }, [busy, pending, onLockChange])
  const list = useAgentQuery(
    JSON.stringify([open, kind, page, pageSize, attempt]),
    async () => (open ? listAgentWorkspaces(kind, page, pageSize) : null),
  )

  function confirmed(entry: AgentWorkspaceEntry) {
    setActive(entry)
    setName(entry.name)
    setPending(null)
    setError(null)
    setNotice(
      `${entry.kind === 'draft' ? '草稿' : '模板'}已保存 · 修订 ${entry.revision}`,
    )
    setAttempt((value) => value + 1)
  }
  async function save(update: boolean, retry = false) {
    if (busy || locked || (pending && !retry)) return
    let input: AgentWorkspaceSave
    try {
      input =
        retry && pending
          ? pending
          : {
              id: update && active ? active.id : crypto.randomUUID(),
              kind,
              name: name.trim(),
              expectedRevision: update && active ? active.revision : 0,
              data: planFromDraft(draft),
            }
      if (!input.name) throw new Error('请填写草稿或模板名称。')
    } catch (cause) {
      setError(agentError(cause))
      return
    }
    const current = scope.begin()
    setPending(input)
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const entry = await saveAgentWorkspace(input)
      if (current()) confirmed(entry)
    } catch (cause) {
      if (current())
        setError(
          `${agentError(cause)} 保存未确认；表单已冻结，请读取原保存结果或核对原请求。`,
        )
    } finally {
      if (current()) setBusy(false)
    }
  }
  async function reconcile() {
    if (!pending || busy) return
    const current = scope.begin()
    setBusy(true)
    try {
      const entry = await getAgentWorkspace(pending.id)
      if (!current()) return
      const outcome = workspaceSaveOutcome(pending, entry)
      if (outcome === 'saved') confirmed(entry)
      else {
        setPending(null)
        setActive(outcome === 'not_saved' ? entry : null)
        setError(
          outcome === 'conflict'
            ? '修订已被其他操作更新。当前输入已保留，请载入最新版本或另存为新记录。'
            : '原保存尚未应用，当前输入已保留，可以重新保存。',
        )
      }
    } catch (cause) {
      if (current()) setError(`${agentError(cause)} 尚未确认保存结果；原请求标识保留。`)
    } finally {
      if (current()) setBusy(false)
    }
  }
  async function load() {
    if (!loadId || busy || pending || locked) return
    const current = scope.begin()
    setBusy(true)
    setError(null)
    try {
      const entry = await getAgentWorkspace(loadId)
      const [products, targets] = await Promise.all([
        readPickedProducts(entry.data.productIds),
        listAgentTargets(),
      ])
      if (entry.data.windowIds.some((id) => !targets.some((target) => target.id === id)))
        throw new Error('部分执行窗口已不可见，未替换当前表单；请先核对窗口关系。')
      const restored = draftFromPlan(entry.data, products)
      if (!current()) return
      onLoaded(restored)
      setActive(entry)
      setName(entry.name)
      setKind(entry.kind)
      setNotice('已载入最新商品与窗口关系；价格、发布记录和账号状态将重新检查。')
      setLoadId(null)
      setOpen(false)
    } catch (cause) {
      if (current()) {
        setError(agentError(cause))
        setLoadId(null)
      }
    } finally {
      if (current()) setBusy(false)
    }
  }
  async function remove() {
    if (!deleting || busy || pending) return
    const current = scope.begin()
    setBusy(true)
    try {
      await deleteAgentWorkspace(deleting.id, deleting.revision)
      if (!current()) return
      if (active?.id === deleting.id) setActive(null)
      setDeleting(null)
      setNotice('记录已删除。')
      setAttempt((value) => value + 1)
    } catch (cause) {
      if (current()) setError(`${agentError(cause)} 请刷新列表核对，未反馈删除成功。`)
    } finally {
      if (current()) setBusy(false)
    }
  }
  return (
    <>
      <div className="sales-agent-toolbar">
        <Button
          size="sm"
          variant="outline"
          disabled={locked}
          onClick={() => setOpen(true)}
        >
          草稿与模板
        </Button>
        {active ? (
          <span className="text-muted-foreground">
            已载入 {active.name} · 修订 {active.revision}
          </span>
        ) : null}
        {notice ? (
          <span role="status" className="text-muted-foreground">
            {notice}
          </span>
        ) : null}
      </div>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy && !pending) setOpen(value)
        }}
      >
        <DialogContent className="sales-agent-dialog" showCloseButton={!busy && !pending}>
          <DialogHeader>
            <DialogTitle>草稿与模板</DialogTitle>
            <DialogDescription>
              保存稳定的商品、窗口关系和本次编辑。载入时读取最新来源资料；模型密钥和图片内容不随草稿保存。
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="sales-agent-form-grid">
            <Field>
              <FieldLabel htmlFor="agent-workspace-kind">类型</FieldLabel>
              <LabeledSelect
                id="agent-workspace-kind"
                ariaLabel="保存类型"
                value={kind}
                disabled={busy || !!pending}
                options={[
                  { value: 'draft', label: '草稿' },
                  { value: 'template', label: '模板' },
                ]}
                onValueChange={(value) => {
                  if (value === 'draft' || value === 'template') {
                    setKind(value)
                    setPage(1)
                  }
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-workspace-name">名称</FieldLabel>
              <Input
                id="agent-workspace-name"
                value={name}
                maxLength={120}
                disabled={busy || !!pending}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <div className="sales-agent-toolbar">
            <Button
              size="sm"
              disabled={busy || !!pending || !name.trim()}
              onClick={() => void save(false)}
            >
              另存为新{kind === 'draft' ? '草稿' : '模板'}
            </Button>
            {active?.kind === kind ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !!pending || !name.trim()}
                onClick={() => void save(true)}
              >
                更新已载入记录
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || list.loading}
              onClick={() => setAttempt((value) => value + 1)}
            >
              刷新列表
            </Button>
          </div>
          {error || list.error ? (
            <Alert variant="destructive">
              <AlertDescription>{error ?? list.error}</AlertDescription>
            </Alert>
          ) : null}
          {pending ? (
            <div className="sales-agent-toolbar">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void reconcile()}
              >
                读取原保存结果
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void save(false, true)}
              >
                核对原保存请求
              </Button>
            </div>
          ) : null}
          <div className="sales-agent-picker-list">
            <Table aria-label="已保存草稿与模板">
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>修订 / 更新时间</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data?.items.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>{entry.name}</TableCell>
                    <TableCell>
                      {entry.revision} · {new Date(entry.updatedAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <div className="sales-agent-toolbar">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || !!pending}
                          onClick={() => setLoadId(entry.id)}
                        >
                          载入
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || !!pending}
                          onClick={() => setDeleting(entry)}
                        >
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {list.data && !list.data.items.length ? (
              <p className="sales-agent-control-help">暂无保存记录。</p>
            ) : null}
          </div>
          {list.data ? (
            <AgentPagination
              label="保存记录"
              total={list.data.total}
              page={list.data.page}
              pageSize={pageSize}
              busy={busy || !!pending}
              onPage={setPage}
              onPageSize={(size) => {
                setPageSize(size)
                setPage(1)
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!loadId || !!deleting}
        onOpenChange={(value) => {
          if (!value && !busy) {
            setLoadId(null)
            setDeleting(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleting ? `删除 ${deleting.name}？` : '载入并替换当前表单？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? '仅删除此保存记录，不删除商品、窗口或运行事实。'
                : '先读取最新来源资料。确认后替换当前未提交表单；如需保留当前编辑，请先返回保存。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>返回</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                if (deleting) void remove()
                else void load()
              }}
            >
              {busy ? '处理中…' : deleting ? '确认删除' : '确认载入'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
