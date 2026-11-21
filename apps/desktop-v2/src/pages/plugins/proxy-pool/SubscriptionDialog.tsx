import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  AlertModal,
  Button,
  Checkbox,
  DialogModal,
  EmptyState,
  Input,
  Modal,
  Select,
  Switch,
} from '@proxyshard/shardx-ui-kit'
import { proxyPoolApi } from '../../../raccoon/plugins/proxy-pool/api'
import {
  dateTime,
  errorMessage,
  SCHEMES,
  type ProxyGroup,
  type Scheme,
  type Subscription,
} from '../../../raccoon/plugins/proxy-pool/model'

export function ProxySubscriptionDialog({
  selectedIds,
  groups,
  onClose,
}: {
  selectedIds: string[]
  groups: ProxyGroup[]
  onClose: () => void
}) {
  const [items, setItems] = useState<Subscription[]>([])
  const [loaded, setLoaded] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [groupName, setGroupName] = useState('PROXY')
  const [sourceMode, setSourceMode] = useState(
    selectedIds.length > 0 ? 'selected' : 'groups',
  )
  const [pickedGroups, setPickedGroups] = useState<string[]>([])
  const [preferred, setPreferred] = useState('auto')
  const [includeDirect, setIncludeDirect] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Subscription | null>(null)
  const [preview, setPreview] = useState<{
    name: string
    yaml: string
    nodeCount: number
    excludedCount: number
  } | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void proxyPoolApi
      .subscriptions()
      .then((result) => {
        if (mounted.current) {
          setItems(result)
          setLoaded(true)
        }
      })
      .catch((cause) => {
        if (mounted.current) setError(errorMessage(cause))
      })
    return () => {
      mounted.current = false
    }
  }, [])

  async function refresh() {
    const result = await proxyPoolApi.subscriptions()
    if (mounted.current) {
      setItems(result)
      setLoaded(true)
    }
  }

  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function create() {
    if (!name.trim() || !groupName.trim()) {
      setError('请填写订阅名称和 Clash 分组名')
      return
    }
    if (sourceMode === 'selected' && selectedIds.length === 0) {
      setError('请先在库存中选择代理')
      return
    }
    if (sourceMode === 'groups' && pickedGroups.length === 0) {
      setError('请选择至少一个分组')
      return
    }
    await run(async () => {
      await proxyPoolApi.createSubscription({
        name: name.trim(),
        enabled: true,
        sourceMode: sourceMode === 'groups' ? 'groups' : 'selected',
        proxyIds: sourceMode === 'selected' ? selectedIds.map(Number) : [],
        groupIds: sourceMode === 'groups' ? pickedGroups.map(Number) : [],
        groupName: groupName.trim(),
        includeDirect,
        preferredScheme: preferred === 'auto' ? null : (preferred as Scheme),
      })
      setCreating(false)
      setName('')
      setNotice('订阅已创建')
      try {
        await refresh()
      } catch {
        setError('订阅已创建，列表刷新失败，请重新读取')
      }
    })
  }

  return (
    <>
      <Modal
        open
        title="Clash 订阅"
        size="lg"
        dirty={creating && Boolean(name || pickedGroups.length)}
        onOpenChange={(open) => {
          if (!open && !busy) onClose()
        }}
        footer={
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            disabled={busy}
            onClick={onClose}
          >
            关闭
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          {error && (
            <Alert status="error" variant="lighter">
              {error}
            </Alert>
          )}
          {notice && (
            <Alert status="information" variant="lighter">
              {notice}
            </Alert>
          )}
          <div className="flex items-center justify-between gap-4">
            <span className="text-secondary tabular-nums text-text-sub-600">
              {loaded ? `${items.length} 个订阅` : '正在读取订阅'}
            </span>
            <div className="flex gap-2">
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                disabled={busy}
                onClick={() => void run(refresh)}
              >
                刷新
              </Button>
              <Button size="xsmall" disabled={busy} onClick={() => setCreating(true)}>
                新建订阅
              </Button>
            </div>
          </div>
          {!creating && loaded && items.length === 0 && (
            <EmptyState title="尚未创建订阅" hint="选择库存节点或分组来创建 Clash 订阅" />
          )}
          {items.map((item) => (
            <div key={item.id} className="row-line flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-ui font-medium text-text-strong-950">
                  {item.name}
                </span>
                <span className="text-secondary text-text-soft-400">
                  {item.enabled ? '启用' : '停用'} · {item.memberCount} 个
                  {item.sourceMode === 'groups' ? '分组' : '节点'}
                </span>
              </div>
              <div className="flex flex-wrap gap-3 text-secondary text-text-soft-400">
                <code>{item.groupName}</code>
                <span>更新于 {dateTime(item.updatedAt)}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="xsmall"
                  mode="stroke"
                  variant="neutral"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const data = await proxyPoolApi.previewSubscription(item.id)
                      setPreview({ name: item.name, ...data })
                    })
                  }
                >
                  预览
                </Button>
                <Button
                  size="xsmall"
                  mode="stroke"
                  variant="neutral"
                  disabled={busy || !item.enabled}
                  onClick={() =>
                    void run(async () => {
                      const data = await proxyPoolApi.exportSubscription(item.id)
                      setNotice(
                        `已生成 ${data.filename}，${data.nodeCount} 个节点，${data.bytes} 字节。文件位于插件私有目录 ${data.handle}，包含明文密码`,
                      )
                    })
                  }
                >
                  导出文件
                </Button>
                <Button
                  size="xsmall"
                  mode="ghost"
                  variant="neutral"
                  disabled={
                    busy || selectedIds.length === 0 || item.sourceMode !== 'selected'
                  }
                  onClick={() =>
                    void run(async () => {
                      const data = await proxyPoolApi.appendSubscription(
                        item.id,
                        selectedIds,
                      )
                      setNotice(
                        `已追加 ${data.added} 个节点，重复 ${data.duplicates} 个，现有 ${data.total} 个节点`,
                      )
                      try {
                        await refresh()
                      } catch {
                        setError('追加已完成，列表刷新失败，请重新读取')
                      }
                    })
                  }
                >
                  追加选中
                </Button>
                <Button
                  size="xsmall"
                  mode="ghost"
                  variant="error"
                  disabled={busy}
                  onClick={() => setDeleting(item)}
                >
                  删除
                </Button>
              </div>
            </div>
          ))}
          <p className="text-help text-text-soft-400">
            预览隐藏密码。导出文件保存在插件私有目录并包含明文凭据
          </p>
        </div>
      </Modal>
      {creating && (
        <DialogModal
          open
          title="新建 Clash 订阅"
          dirty={Boolean(name || pickedGroups.length)}
          onOpenChange={(open) => {
            if (!open && !busy) setCreating(false)
          }}
          confirmLabel="创建订阅"
          cancelLabel="取消"
          isLoading={busy}
          onConfirm={() => void create()}
          onCancel={() => {
            if (!busy) setCreating(false)
          }}
        >
          <fieldset disabled={busy} className="flex flex-col gap-4 py-4">
            {error && (
              <Alert status="error" variant="lighter">
                {error}
              </Alert>
            )}
            <Input
              label="订阅名称"
              inputSize="xsmall"
              autoFocus
              value={name}
              maxLength={128}
              onChange={(event) => setName(event.target.value)}
            />
            <Select
              label="节点来源"
              size="xsmall"
              value={sourceMode}
              onChange={setSourceMode}
              options={[
                {
                  value: 'selected',
                  label: `选中的 ${selectedIds.length} 个代理`,
                  disabled: selectedIds.length === 0,
                },
                { value: 'groups', label: '按分组' },
              ]}
            />
            {sourceMode === 'groups' && (
              <div className="flex flex-wrap gap-4">
                {groups.length === 0 ? (
                  <span>尚无分组</span>
                ) : (
                  groups.map((group) => (
                    <Checkbox
                      key={group.id}
                      label={group.name}
                      checked={pickedGroups.includes(String(group.id))}
                      onCheckedChange={(checked) =>
                        setPickedGroups((current) =>
                          checked
                            ? [...current, String(group.id)]
                            : current.filter((id) => id !== String(group.id)),
                        )
                      }
                    />
                  ))
                )}
              </div>
            )}
            <Input
              label="Clash 分组名"
              inputSize="xsmall"
              value={groupName}
              maxLength={128}
              onChange={(event) => setGroupName(event.target.value)}
            />
            <Select
              label="首选协议"
              size="xsmall"
              value={preferred}
              onChange={setPreferred}
              options={[
                { value: 'auto', label: '自动' },
                ...SCHEMES.map((scheme) => ({
                  value: scheme,
                  label: scheme.toUpperCase(),
                })),
              ]}
            />
            <Switch
              label="包含 DIRECT"
              checked={includeDirect}
              onChange={setIncludeDirect}
            />
          </fieldset>
        </DialogModal>
      )}
      <Modal
        open={preview !== null}
        title={preview?.name}
        size="lg"
        onOpenChange={(open) => {
          if (!open) setPreview(null)
        }}
        footer={
          <Button
            size="xsmall"
            mode="stroke"
            variant="neutral"
            onClick={() => setPreview(null)}
          >
            关闭
          </Button>
        }
      >
        <p className="mb-3 text-secondary text-text-sub-600">
          {preview?.nodeCount} 个节点，排除 {preview?.excludedCount} 个节点，密码已脱敏
        </p>
        <pre className="max-h-96 overflow-auto whitespace-pre rounded-control bg-bg-weak-50 p-3 text-mono text-text-sub-600">
          {preview?.yaml}
        </pre>
      </Modal>
      <AlertModal
        open={deleting !== null}
        status="error"
        title={`删除订阅 ${deleting?.name ?? ''}`}
        description="删除后订阅令牌作废"
        confirmLabel="删除订阅"
        isLoading={busy}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null)
        }}
        onConfirm={() => {
          if (deleting)
            void run(async () => {
              await proxyPoolApi.deleteSubscription(deleting.id)
              setDeleting(null)
              setNotice('订阅已删除')
              try {
                await refresh()
              } catch {
                setError('订阅已删除，列表刷新失败，请重新读取')
              }
            })
        }}
      />
    </>
  )
}
