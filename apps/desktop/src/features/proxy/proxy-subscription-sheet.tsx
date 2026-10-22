import { useEffect, useState, type FormEvent } from 'react'
import { Download, Eye, Loader2, Plus, Trash2 } from 'lucide-react'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import {
  appendToSubscription,
  createSubscription,
  deleteSubscription,
  exportSubscription,
  listSubscriptions,
  previewSubscription,
  type SubscriptionInput,
} from './api'
import { ProxySelect } from './proxy-select'
import {
  SCHEMES,
  formatDateTime,
  message,
  type ProxyGroup,
  type Scheme,
  type SubscriptionSummary,
} from './types'

export interface ProxySubscriptionSheetProps {
  /** Ids selected in the table; drives the "add to subscription" entry point. */
  selectedIds: string[]
  groups: ProxyGroup[]
  onOpenChange: (open: boolean) => void
}

export function ProxySubscriptionSheet({
  selectedIds,
  groups,
  onOpenChange,
}: ProxySubscriptionSheetProps) {
  const [items, setItems] = useState<SubscriptionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(selectedIds.length > 0)
  const [name, setName] = useState('')
  const [groupName, setGroupName] = useState('PROXY')
  const [sourceMode, setSourceMode] = useState<'selected' | 'groups'>(
    selectedIds.length > 0 ? 'selected' : 'groups',
  )
  const [pickedGroups, setPickedGroups] = useState<string[]>([])
  const [preferredScheme, setPreferredScheme] = useState('auto')
  const [includeDirect, setIncludeDirect] = useState(true)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [preview, setPreview] = useState<{
    name: string
    yaml: string
    nodes: number
  } | null>(null)
  const [deleting, setDeleting] = useState<SubscriptionSummary | null>(null)

  useEffect(() => {
    let active = true
    void listSubscriptions().then(
      (data) => {
        if (active) setItems(data.items)
      },
      (cause: unknown) => {
        if (active) setError(message(cause))
      },
    )
    return () => {
      active = false
    }
  }, [])

  async function refresh() {
    const data = await listSubscriptions()
    setItems(data.items)
  }

  async function run(action: () => Promise<void>) {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setPending(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (name.trim() === '') return setError('请输入订阅名称。')
    if (sourceMode === 'groups' && pickedGroups.length === 0) {
      return setError('请至少选择一个分组。')
    }
    if (sourceMode === 'selected' && selectedIds.length === 0) {
      return setError('请先在表格中选中代理，或改为按分组订阅。')
    }
    const body: SubscriptionInput = {
      name: name.trim(),
      enabled: true,
      sourceMode,
      proxyIds: sourceMode === 'selected' ? selectedIds.map(Number) : [],
      groupIds: sourceMode === 'groups' ? pickedGroups.map(Number) : [],
      groupName: groupName.trim() === '' ? 'PROXY' : groupName.trim(),
      includeDirect,
      preferredScheme: preferredScheme === 'auto' ? null : (preferredScheme as Scheme),
    }
    await run(async () => {
      await createSubscription(body)
      setName('')
      setCreating(false)
      setNotice('订阅已创建。预览与导出都在本页完成。')
      await refresh()
    })
  }

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Clash 订阅</SheetTitle>
          <SheetDescription>
            订阅把代理渲染为 Clash
            配置。预览会隐去密码；导出文件写在插件私有目录，包含明文密码。
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {error === null ? null : <FieldError role="alert">{error}</FieldError>}
          {notice === null ? null : (
            <p className="proxy-result" role="status">
              {notice}
            </p>
          )}
          <div className="proxy-sub-toolbar">
            <span className="proxy-result">
              {items === null ? '读取中…' : `${items.length} 个订阅`}
            </span>
            <Button
              size="sm"
              variant={creating ? 'secondary' : 'default'}
              disabled={pending}
              onClick={() => setCreating((current) => !current)}
            >
              <Plus data-icon="inline-start" />
              新建订阅
            </Button>
          </div>
          {creating ? (
            <form className="proxy-form-section" onSubmit={submit}>
              <h3>新建订阅</h3>
              <Field>
                <FieldLabel htmlFor="sub-name">名称</FieldLabel>
                <Input
                  id="sub-name"
                  maxLength={128}
                  disabled={pending}
                  placeholder="例如：主力节点"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <div className="proxy-form-grid">
                <Field>
                  <FieldLabel htmlFor="sub-source">来源</FieldLabel>
                  <ProxySelect
                    id="sub-source"
                    ariaLabel="订阅来源"
                    value={sourceMode}
                    disabled={pending}
                    onValueChange={(value) =>
                      setSourceMode(value === 'groups' ? 'groups' : 'selected')
                    }
                    options={[
                      { value: 'selected', label: `选中的代理（${selectedIds.length}）` },
                      { value: 'groups', label: '按分组' },
                    ]}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="sub-group-name">Clash 分组名</FieldLabel>
                  <Input
                    id="sub-group-name"
                    maxLength={128}
                    disabled={pending}
                    value={groupName}
                    onChange={(event) => setGroupName(event.target.value)}
                  />
                </Field>
              </div>
              {sourceMode === 'groups' ? (
                <Field>
                  <FieldLabel>包含分组</FieldLabel>
                  <div className="proxy-scheme-picker">
                    {groups.length === 0 ? (
                      <span className="proxy-detail-note">还没有分组。</span>
                    ) : (
                      groups.map((group) => (
                        <label key={group.id}>
                          <Checkbox
                            checked={pickedGroups.includes(String(group.id))}
                            disabled={pending}
                            onCheckedChange={(checked) =>
                              setPickedGroups((current) =>
                                checked === true
                                  ? [...current, String(group.id)]
                                  : current.filter((value) => value !== String(group.id)),
                              )
                            }
                          />
                          {group.name}
                        </label>
                      ))
                    )}
                  </div>
                </Field>
              ) : null}
              <div className="proxy-form-grid">
                <Field>
                  <FieldLabel htmlFor="sub-scheme">首选协议</FieldLabel>
                  <ProxySelect
                    id="sub-scheme"
                    ariaLabel="首选协议"
                    value={preferredScheme}
                    disabled={pending}
                    onValueChange={setPreferredScheme}
                    options={[
                      { value: 'auto', label: '自动' },
                      ...SCHEMES.map((scheme) => ({
                        value: scheme,
                        label: scheme.toUpperCase(),
                      })),
                    ]}
                  />
                </Field>
                <Field className="proxy-switch-field" orientation="horizontal">
                  <FieldLabel htmlFor="sub-direct">包含 DIRECT</FieldLabel>
                  <Switch
                    id="sub-direct"
                    checked={includeDirect}
                    disabled={pending}
                    onCheckedChange={setIncludeDirect}
                  />
                </Field>
              </div>
              <FieldDescription>
                令牌由插件生成并保存在它自己的私有目录，宿主不读取。
              </FieldDescription>
              <div className="proxy-sub-actions">
                <Button type="submit" size="sm" disabled={pending}>
                  {pending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : null}
                  创建
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setCreating(false)}
                >
                  取消
                </Button>
              </div>
            </form>
          ) : null}
          {items === null ? null : items.length === 0 ? (
            <p className="proxy-detail-note">还没有订阅。选中代理后可以一键创建。</p>
          ) : (
            <ul className="proxy-sub-list">
              {items.map((item) => (
                <li key={item.id}>
                  <div className="proxy-sub-head">
                    <strong>{item.name}</strong>
                    <Badge variant={item.enabled ? 'secondary' : 'outline'}>
                      {item.enabled ? '启用' : '停用'}
                    </Badge>
                    <span className="proxy-result">
                      {item.memberCount} 个
                      {item.sourceMode === 'groups' ? '分组' : '节点'}
                    </span>
                  </div>
                  <div className="proxy-sub-meta">
                    <code>{item.groupName}</code>
                    <span>更新于 {formatDateTime(item.updatedAt)}</span>
                  </div>
                  <div className="proxy-sub-actions">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        void run(async () => {
                          const data = await previewSubscription(item.id)
                          setPreview({
                            name: item.name,
                            yaml: data.yaml,
                            nodes: data.nodeCount,
                          })
                        })
                      }
                    >
                      <Eye data-icon="inline-start" />
                      预览
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || !item.enabled}
                      onClick={() =>
                        void run(async () => {
                          const data = await exportSubscription(item.id)
                          setNotice(
                            `已写入插件私有目录：${data.handle}（${data.bytes} 字节，${data.nodeCount} 个节点）。文件包含明文密码。`,
                          )
                        })
                      }
                    >
                      <Download data-icon="inline-start" />
                      导出
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={
                        pending ||
                        selectedIds.length === 0 ||
                        item.sourceMode !== 'selected'
                      }
                      title={
                        item.sourceMode === 'selected'
                          ? '把表格中选中的代理追加到这个订阅'
                          : '按分组订阅会自动跟随分组，无需追加'
                      }
                      onClick={() =>
                        void run(async () => {
                          const data = await appendToSubscription(item.id, selectedIds)
                          setNotice(
                            `已追加 ${data.addedCount} 条，跳过 ${data.duplicateCount} 条重复；订阅现有 ${data.memberCount} 个节点。`,
                          )
                          await refresh()
                        })
                      }
                    >
                      <Plus data-icon="inline-start" />
                      追加选中
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => setDeleting(item)}
                    >
                      <Trash2 data-icon="inline-start" />
                      删除
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SheetBody>
        <SheetFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </SheetFooter>
      </SheetContent>
      <Dialog
        open={preview !== null}
        onOpenChange={(next) => {
          if (!next) setPreview(null)
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{preview?.name}</DialogTitle>
            <DialogDescription>
              预览中的密码已替换为 ***，共 {preview?.nodes ?? 0}{' '}
              个节点；导出文件才包含真实凭据。
            </DialogDescription>
          </DialogHeader>
          <pre className="proxy-preview">{preview?.yaml}</pre>
          <DialogFooter>
            <Button onClick={() => setPreview(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除订阅「{deleting?.name ?? ''}」？</AlertDialogTitle>
            <AlertDialogDescription>
              订阅令牌会同时作废，已经拿到旧订阅地址的客户端会立即失效。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault()
                const target = deleting
                if (target === null) return
                void run(async () => {
                  await deleteSubscription(target.id)
                  setDeleting(null)
                  setNotice('订阅已删除。')
                  await refresh()
                })
              }}
            >
              删除订阅
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}
