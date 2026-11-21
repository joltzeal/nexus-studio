import { useState } from 'react'
import {
  Alert,
  Checkbox,
  DialogModal,
  EmptyState,
  Select,
} from '@proxyshard/shardx-ui-kit'
import { useWorkspace, workspace } from '../../../raccoon/store'
import {
  addressOf,
  errorMessage,
  PROXY_PLUGIN_ID,
  type ProxyRow,
} from '../../../raccoon/plugins/proxy-pool/model'

export function ProxyAssignDialog({
  row,
  onClose,
}: {
  row: ProxyRow
  onClose: () => void
}) {
  const state = useWorkspace()
  const [connectionId] = useState(state.connectionId)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState('fixed')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(0)
  const connection = state.connections.find((entry) => entry.id === connectionId)
  const changed = state.connectionId !== connectionId
  const capabilities = state.probe?.capabilities
  const available =
    !changed &&
    Boolean(state.probe?.connected && capabilities?.update && capabilities.proxyPlugin)
  const profiles = changed ? [] : state.profiles

  async function assign() {
    if (busy || !available || selected.size === 0) return
    setBusy(true)
    setError(null)
    const failures: string[] = []
    const remaining = new Set(selected)
    let completed = saved
    for (const id of selected) {
      if (workspace.state.connectionId !== connectionId) {
        failures.push('Workspace 已切换，请重新打开分配窗口')
        break
      }
      const profile = workspace.state.profiles.find((item) => item.id === id)
      if (!profile || profile.state !== 'stopped') {
        failures.push(`${profile?.name ?? 'Profile'} 当前无法修改`)
        continue
      }
      try {
        await workspace.update({
          id: profile.id,
          name: profile.name,
          settings: profile.settings,
          groupId: profile.groupId,
          proxyMode: 'plugin',
          proxyId: null,
          proxy: null,
          proxyPlugin: PROXY_PLUGIN_ID,
          proxyEndpoint: mode === 'default' ? null : Number(row.id),
        })
        remaining.delete(id)
        completed++
      } catch (cause) {
        failures.push(`${profile.name} · ${errorMessage(cause)}`)
      }
    }
    setSelected(remaining)
    setSaved(completed)
    setBusy(false)
    if (failures.length) setError(failures.join('\n'))
    else onClose()
  }

  return (
    <DialogModal
      open
      title="分配给 Profile"
      size="lg"
      dirty={selected.size > 0}
      subtitle={`${row.name} · ${addressOf(row)}`}
      isLoading={busy}
      isDisabled={!available || selected.size === 0}
      cancelLabel="关闭"
      confirmLabel={`分配 ${selected.size} 个 Profile`}
      onConfirm={() => void assign()}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
      onCancel={() => {
        if (!busy) onClose()
      }}
    >
      <fieldset disabled={busy || !available} className="flex flex-col gap-4 py-4">
        <p className="text-secondary text-text-sub-600">
          当前 Workspace · {connection?.name ?? '未选择'}
        </p>
        {!available && (
          <Alert status="warning" variant="lighter">
            {changed
              ? 'Workspace 已切换，请重新打开分配窗口'
              : '当前接入未连接或不支持插件代理配置'}
          </Alert>
        )}
        {saved > 0 && (
          <Alert status="information" variant="lighter">
            已保存 {saved} 个 Profile
          </Alert>
        )}
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        <Select
          label="代理来源"
          size="xsmall"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'fixed', label: '固定使用此端点' },
            { value: 'default', label: '跟随代理池默认项' },
          ]}
          hint={
            mode === 'default'
              ? '默认项发生变化后，下次启动使用新的默认代理'
              : '此端点缺失或停用时阻断启动'
          }
        />
        <div className="flex max-h-80 flex-col overflow-auto">
          {profiles.length === 0 && <EmptyState title="当前 Workspace 没有 Profile" />}
          {profiles.map((profile) => (
            <div
              key={profile.id}
              className="row-line flex items-center justify-between gap-3 py-3"
            >
              <Checkbox
                label={profile.name}
                disabled={busy || !available || profile.state !== 'stopped'}
                checked={selected.has(profile.id)}
                onCheckedChange={(checked) =>
                  setSelected((current) => {
                    const next = new Set(current)
                    if (checked) next.add(profile.id)
                    else next.delete(profile.id)
                    return next
                  })
                }
              />
              <span className="shrink-0 text-secondary text-text-soft-400">
                {profile.state === 'stopped'
                  ? '已停止'
                  : profile.state === 'running'
                    ? '运行中'
                    : '状态未确认'}
              </span>
            </div>
          ))}
        </div>
      </fieldset>
    </DialogModal>
  )
}
