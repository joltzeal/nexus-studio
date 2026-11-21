import { useEffect, useState } from 'react'
import { Alert, Button, Input, Select } from '@proxyshard/shardx-ui-kit'
import { emailApi } from '../../../raccoon/plugins/email/api'
import type { EmailSettings as Settings } from '../../../raccoon/plugins/email/model'
import { usePluginTask } from '../usePluginTask'

export function EmailSettings({ disabled }: { disabled: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const task = usePluginTask()
  useEffect(() => {
    if (disabled) return
    let active = true
    void emailApi.settings().then(
      (value) => {
        if (active) {
          setSettings(value)
          setDraft(value)
        }
      },
      (cause) => {
        if (active) setError(cause instanceof Error ? cause.message : '邮箱设置读取失败')
      },
    )
    return () => {
      active = false
    }
  }, [disabled])
  if (disabled)
    return (
      <Alert status="information" variant="lighter">
        邮箱插件未运行，无法读取设置。
      </Alert>
    )
  if (!draft || !settings)
    return (
      <div className="text-secondary text-text-soft-400">
        {error ?? '正在读取邮箱设置…'}
      </div>
    )
  const changed = JSON.stringify(draft) !== JSON.stringify(settings)
  async function save() {
    if (!task.acquire()) return
    const token = task.begin()
    setBusy(true)
    setError(null)
    try {
      const result = await emailApi.saveSettings(draft!)
      if (!task.current(token)) return
      setSettings(result)
      setDraft(result)
    } catch (cause) {
      if (task.current(token))
        setError(cause instanceof Error ? cause.message : '设置保存失败')
    } finally {
      task.release()
      if (task.current(token)) setBusy(false)
    }
  }
  return (
    <section className="flex flex-col gap-3 rounded-panel bg-bg-raised p-4 shadow-(--shadow-xs)">
      <h2 className="m-0 text-panel-title text-text-strong-950">邮箱任务设置</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="自动刷新 token"
          size="xsmall"
          value={String(draft.autoRefresh)}
          onChange={(value) => setDraft({ ...draft, autoRefresh: value === 'true' })}
          options={[
            { value: 'true', label: '开启' },
            { value: 'false', label: '关闭' },
          ]}
        />
        <Input
          inputSize="xsmall"
          label="刷新间隔（分钟）"
          inputMode="numeric"
          value={String(draft.intervalMinutes)}
          onChange={(event) =>
            setDraft({ ...draft, intervalMinutes: Number(event.target.value) })
          }
          hint="5–1440 分钟"
        />
        <Select
          label="自动收信"
          size="xsmall"
          value={String(draft.autoReceive)}
          onChange={(value) => setDraft({ ...draft, autoReceive: value === 'true' })}
          options={[
            { value: 'true', label: '开启' },
            { value: 'false', label: '关闭' },
          ]}
        />
        <Input
          inputSize="xsmall"
          label="收信间隔（分钟）"
          inputMode="numeric"
          value={String(draft.receiveIntervalMinutes)}
          onChange={(event) =>
            setDraft({ ...draft, receiveIntervalMinutes: Number(event.target.value) })
          }
          hint="1–60 分钟"
        />
      </div>
      {error && (
        <Alert status="error" variant="lighter">
          {error}
        </Alert>
      )}
      <Button
        className="self-start"
        size="xsmall"
        disabled={busy || !changed}
        onClick={() => void save()}
      >
        保存设置
      </Button>
      <p className="m-0 text-secondary text-text-soft-400">
        手动排队任务也由插件持久化；停止自动任务不会隐藏单项操作。
      </p>
    </section>
  )
}
