import { useState } from 'react'
import { Alert, Button, DialogModal, Select } from '@proxyshard/shardx-ui-kit'
import { useWorkspace, workspace } from '../../../raccoon/store'
import { accountsApi } from '../../../raccoon/plugins/vinted-accounts/api'
import { usePluginTask } from '../usePluginTask'
import type { LinkedProfile } from '../../../raccoon/plugins/vinted-accounts/table'

export function ProfileBindings({
  account,
  bindings,
  linkedProfiles,
  connectionId,
  onSaved,
  onClose,
}: {
  account: { id: string; account: string }
  bindings: { accountId: string; windowId: string }[]
  linkedProfiles: readonly LinkedProfile[]
  connectionId: string | null
  onSaved: () => void
  onClose: () => void
}) {
  const state = useWorkspace()
  const profiles = state.profiles.filter((item) => item.connectionId === connectionId)
  const [selected, setSelected] = useState('')
  const [pending, setPending] = useState<{
    windowId: string
    unlink: boolean
    confirmedDuplicates: boolean
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const task = usePluginTask()
  async function save() {
    if (!pending || !task.acquire()) return
    const token = task.begin()
    setBusy(true)
    setError(null)
    try {
      const available = () =>
        workspace.state.connectionId === connectionId &&
        workspace.state.profiles.some(
          (item) => item.id === pending.windowId && item.connectionId === connectionId,
        )
      if (!available()) throw new Error('Profile 已不属于当前 Workspace，请重新打开。')
      const latest = await accountsApi.bindings()
      if (!task.current(token) || !available()) return
      const previous = bindings.find((item) => item.windowId === pending.windowId)
      const current = latest.items.find((item) => item.windowId === pending.windowId)
      if (previous?.accountId !== current?.accountId)
        throw new Error('Profile 绑定已变化，请关闭并刷新后重试。')
      if (pending.unlink) await accountsApi.unbindWindow(pending.windowId)
      else {
        const result = await accountsApi.bindAccount(
          account.id,
          pending.windowId,
          pending.confirmedDuplicates,
        )
        if (!task.current(token)) return
        if (!result.bound) {
          setPending({ ...pending, confirmedDuplicates: true })
          setError(
            `该账号还绑定了 ${result.duplicates.length} 个其他 Profile。再次确认会保留这些绑定。`,
          )
          return
        }
      }
      if (task.current(token)) onSaved()
    } catch (cause) {
      if (task.current(token))
        setError(cause instanceof Error ? cause.message : 'Profile 关联失败')
    } finally {
      task.release()
      if (task.current(token)) setBusy(false)
    }
  }
  const linked = profiles.filter((item) =>
    bindings.some(
      (binding) => binding.windowId === item.id && binding.accountId === account.id,
    ),
  )
  const editableIds = new Set(linked.map((item) => item.id))
  const workspaceNames = new Map(state.connections.map((item) => [item.id, item.name]))
  return (
    <DialogModal
      open
      title="关联配置"
      subtitle={`账号 ${account.account} · 可编辑当前 Workspace 的关联`}
      confirmLabel={pending ? (pending.unlink ? '确认解除' : '确认绑定') : '完成'}
      isLoading={busy}
      onConfirm={() => {
        if (pending) void save()
        else onClose()
      }}
      onCancel={() => {
        if (!busy) {
          if (pending) setPending(null)
          else onClose()
        }
      }}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <div className="flex flex-col gap-3 py-inset">
        {error && (
          <Alert status="warning" variant="lighter">
            {error}
          </Alert>
        )}
        {pending ? (
          <>
            <p className="m-0 text-secondary text-text-sub-600">
              {pending.unlink ? '解除' : '绑定'} Profile「
              {profiles.find((item) => item.id === pending.windowId)?.name ??
                pending.windowId}
              」
              {!pending.unlink &&
              bindings.some(
                (item) =>
                  item.windowId === pending.windowId && item.accountId !== account.id,
              )
                ? '，替换其已有账号关系'
                : ''}
              ？
            </p>
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              返回
            </Button>
          </>
        ) : (
          <>
            {linkedProfiles.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-2 border-b border-stroke-soft-200 py-2"
              >
                <div className="min-w-0">
                  <p className="m-0 break-words text-secondary text-text-strong-950">
                    {item.name ?? item.id}
                  </p>
                  <p className="m-0 text-help text-text-sub-600">
                    {editableIds.has(item.id)
                      ? '当前 Workspace'
                      : item.connectionId
                        ? (workspaceNames.get(item.connectionId) ?? '其他 Workspace')
                        : '暂无法读取配置详情'}
                  </p>
                </div>
                {editableIds.has(item.id) && (
                  <Button
                    size="xsmall"
                    mode="ghost"
                    variant="neutral"
                    onClick={() =>
                      setPending({
                        windowId: item.id,
                        unlink: true,
                        confirmedDuplicates: false,
                      })
                    }
                  >
                    解除
                  </Button>
                )}
              </div>
            ))}
            {!linkedProfiles.length && (
              <p className="m-0 text-secondary text-text-soft-400">尚未关联配置</p>
            )}
            {connectionId && (
              <>
                <Select
                  label="选择 Profile"
                  size="xsmall"
                  value={selected}
                  onChange={setSelected}
                  options={[
                    { value: '', label: '请选择' },
                    ...profiles
                      .filter((item) => !linked.some((entry) => entry.id === item.id))
                      .map((item) => ({
                        value: item.id,
                        label: `${item.name}${bindings.some((entry) => entry.windowId === item.id) ? ' · 已有账号' : ''}`,
                      })),
                  ]}
                />
                <Button
                  size="xsmall"
                  mode="stroke"
                  variant="neutral"
                  disabled={!selected || state.loading || !connectionId}
                  onClick={() =>
                    setPending({
                      windowId: selected,
                      unlink: false,
                      confirmedDuplicates: false,
                    })
                  }
                >
                  绑定此 Profile
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </DialogModal>
  )
}
