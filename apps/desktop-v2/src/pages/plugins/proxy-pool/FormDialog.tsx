import { useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  DialogModal,
  Input,
  Select,
  Switch,
} from '@proxyshard/shardx-ui-kit'
import { proxyPoolApi } from '../../../raccoon/plugins/proxy-pool/api'
import {
  errorMessage,
  SCHEMES,
  type ProxyGroup,
  type ProxyInput,
  type ProxyRow,
  type Scheme,
} from '../../../raccoon/plugins/proxy-pool/model'
import { parseProxyLink } from '../../../raccoon/plugins/proxy-pool/proxy-link'

export function ProxyFormDialog({
  editing,
  groups,
  onClose,
  onSaved,
}: {
  editing: ProxyRow | null
  groups: ProxyGroup[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [draft, setDraft] = useState({
    name: editing?.name ?? '',
    host: editing?.host ?? '',
    port: String(editing?.port ?? 8080),
    username: editing?.username ?? '',
    password: '',
    group: editing?.groupId ?? 'none',
    schemes: editing?.schemes ?? (['http'] as Scheme[]),
    enabled: editing?.enabled ?? true,
    udp: editing?.udp ?? true,
    passwordMode: 'keep',
  })
  const [initial] = useState(() => JSON.stringify(draft))
  const [localGroups, setLocalGroups] = useState(groups)
  const [newGroup, setNewGroup] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recognized, setRecognized] = useState(false)
  const patch = (value: Partial<typeof draft>) =>
    setDraft((current) => ({ ...current, ...value }))

  function applyLink(value: string) {
    const parsed = parseProxyLink(value)
    if (!parsed) return false
    patch({
      host: parsed.host,
      port: String(parsed.port),
      username: parsed.username,
      password: parsed.password,
      schemes: [parsed.scheme],
      name: draft.name || parsed.host,
      passwordMode: parsed.password ? 'replace' : 'keep',
    })
    setRecognized(true)
    return true
  }

  async function save() {
    if (busy) return
    const port = Number(draft.port)
    if (
      !draft.name.trim() ||
      !draft.host.trim() ||
      draft.schemes.length === 0 ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      setError('请填写名称、主机、有效端口和至少一种协议')
      return
    }
    if (editing && draft.passwordMode === 'replace' && !draft.password) {
      setError('请输入新密码，或选择保留现有密码')
      return
    }
    const input: ProxyInput = {
      name: draft.name.trim(),
      host: draft.host.trim(),
      port,
      username: draft.username,
      schemes: draft.schemes,
      groupId: draft.group === 'none' ? null : Number(draft.group),
      enabled: draft.enabled,
      udp: draft.udp,
      ...(!editing || draft.passwordMode === 'replace'
        ? { password: draft.password }
        : {}),
      ...(editing && draft.passwordMode === 'clear' ? { password: '' } : {}),
    }
    setBusy(true)
    setError(null)
    try {
      if (editing) await proxyPoolApi.update(editing.id, input)
      else await proxyPoolApi.create(input)
      await onSaved()
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function addGroup() {
    if (busy || !newGroup?.trim()) return
    setBusy(true)
    setError(null)
    try {
      const group = await proxyPoolApi.createGroup(newGroup.trim())
      setLocalGroups((current) => [
        ...current.filter((item) => item.id !== group.id),
        group,
      ])
      patch({ group: String(group.id) })
      setNewGroup(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogModal
      open
      title={editing ? '编辑代理' : '新增代理'}
      size="lg"
      dirty={JSON.stringify(draft) !== initial || Boolean(newGroup)}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
      onCancel={() => {
        if (!busy) onClose()
      }}
      cancelLabel="取消"
      confirmLabel="保存代理"
      onConfirm={() => void save()}
      isLoading={busy}
    >
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4 py-4">
        {error && (
          <Alert status="error" variant="lighter">
            {error}
          </Alert>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="名称"
            autoFocus
            inputSize="xsmall"
            maxLength={128}
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
          <Select
            label="分组"
            size="xsmall"
            value={draft.group}
            onChange={(group) => patch({ group })}
            options={[
              { value: 'none', label: '未分组' },
              ...localGroups.map((group) => ({
                value: String(group.id),
                label: group.name,
              })),
            ]}
          />
        </div>
        <div className="flex items-end gap-2">
          {newGroup !== null ? (
            <>
              <Input
                label="新分组名称"
                inputSize="xsmall"
                maxLength={128}
                value={newGroup}
                onChange={(event) => setNewGroup(event.target.value)}
              />
              <Button
                size="xsmall"
                mode="stroke"
                variant="neutral"
                disabled={!newGroup.trim()}
                onClick={() => void addGroup()}
              >
                创建分组
              </Button>
              <Button
                size="xsmall"
                mode="ghost"
                variant="neutral"
                onClick={() => setNewGroup(null)}
              >
                取消
              </Button>
            </>
          ) : (
            <Button
              size="xsmall"
              mode="ghost"
              variant="neutral"
              onClick={() => setNewGroup('')}
            >
              新建分组
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-secondary text-text-sub-600">支持协议</span>
          <div className="flex flex-wrap gap-4">
            {SCHEMES.map((scheme) => (
              <Checkbox
                key={scheme}
                label={scheme.toUpperCase()}
                checked={draft.schemes.includes(scheme)}
                onCheckedChange={(checked) =>
                  patch({
                    schemes: checked
                      ? [...draft.schemes, scheme]
                      : draft.schemes.filter((item) => item !== scheme),
                  })
                }
              />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_112px] gap-4">
          <Input
            label="主机地址"
            technical
            inputSize="xsmall"
            value={draft.host}
            maxLength={4096}
            placeholder="域名、IP 或完整代理链接"
            onChange={(event) => {
              if (!applyLink(event.target.value)) {
                patch({ host: event.target.value })
                setRecognized(false)
              }
            }}
            onPaste={(event) => {
              if (applyLink(event.clipboardData.getData('text'))) event.preventDefault()
            }}
          />
          <Input
            label="端口"
            inputSize="xsmall"
            inputMode="numeric"
            value={draft.port}
            onChange={(event) => patch({ port: event.target.value })}
          />
        </div>
        {recognized && (
          <p role="status" className="text-secondary text-text-sub-600">
            已从链接填入连接信息
          </p>
        )}
        <div className="row-line pt-4 text-ui font-medium text-text-strong-950">认证</div>
        <Input
          label="用户名"
          technical
          inputSize="xsmall"
          maxLength={128}
          value={draft.username}
          onChange={(event) => patch({ username: event.target.value })}
        />
        {editing && (
          <Select
            label="密码处理"
            size="xsmall"
            value={draft.passwordMode}
            onChange={(passwordMode) => patch({ passwordMode, password: '' })}
            hint={editing.hasPassword ? '当前已保存密码' : '当前未保存密码'}
            options={[
              { value: 'keep', label: '保留现有密码' },
              { value: 'replace', label: '替换密码' },
              { value: 'clear', label: '清除密码' },
            ]}
          />
        )}
        {(!editing || draft.passwordMode === 'replace') && (
          <Input
            label="密码"
            inputSize="xsmall"
            secret
            type="password"
            autoComplete="new-password"
            maxLength={512}
            value={draft.password}
            onChange={(event) => patch({ password: event.target.value })}
          />
        )}
        <div className="flex flex-wrap gap-6">
          <Switch
            label="启用代理"
            checked={draft.enabled}
            onChange={(enabled) => patch({ enabled })}
          />
          <Switch
            label="SOCKS UDP"
            checked={draft.udp}
            onChange={(udp) => patch({ udp })}
          />
        </div>
        <p className="text-help text-text-soft-400">
          UDP 用于 Clash 订阅。检测验证 TCP 连接，密码明文保存在插件私有目录
        </p>
      </fieldset>
    </DialogModal>
  )
}
