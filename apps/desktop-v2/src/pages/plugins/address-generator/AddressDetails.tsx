import { useState, type ReactNode } from 'react'
import { IconButton } from '@proxyshard/shardx-ui-kit'
import { CopyIcon } from '../../../shared/icons'
import { clip } from '../../../shared/lib/clipboard'
import { toast } from '../../../shared/model/toast'
import {
  addressText,
  profileFields,
  type Profile,
} from '../../../raccoon/plugins/address-generator/model'
import { usePluginTask } from '../usePluginTask'

export function AddressDetails({
  profile,
  children,
}: {
  profile: Profile
  children?: ReactNode
}) {
  const [copying, setCopying] = useState(false)
  const task = usePluginTask()
  async function copy(label: string, value: string) {
    if (!task.acquire()) return
    const token = task.begin()
    setCopying(true)
    try {
      await clip.write(value)
      if (task.current(token)) toast.ok(`${label}已复制`)
    } catch {
      if (task.current(token)) toast.err('复制失败，请重试')
    } finally {
      task.release()
      if (task.current(token)) setCopying(false)
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <p
          data-selectable
          className="m-0 whitespace-pre-line break-words text-body font-medium text-text-strong-950"
        >
          {addressText(profile)}
        </p>
        <IconButton
          label="复制完整地址"
          icon={<CopyIcon className="size-3.5" />}
          disabled={copying}
          onClick={() => void copy('完整地址', addressText(profile))}
        />
      </div>
      <dl className="m-0 flex flex-col gap-2 text-secondary">
        {profileFields(profile).map((field) => (
          <div
            key={field.id}
            className="grid grid-cols-[72px_minmax(0,1fr)_28px] items-center gap-2"
          >
            <dt className="text-text-soft-400">{field.label}</dt>
            <dd
              data-selectable
              className="m-0 min-w-0 break-words tabular-nums text-text-sub-600 [overflow-wrap:anywhere]"
            >
              {field.value || '—'}
            </dd>
            <IconButton
              label={`复制 ${field.label}`}
              icon={<CopyIcon className="size-3.5" />}
              disabled={copying || field.value === ''}
              onClick={() => void copy(field.label, field.value)}
            />
          </div>
        ))}
      </dl>
      <p className="m-0 text-help text-text-soft-400">
        姓名和用户名为本地生成资料。{profile.approximate ? '坐标为近似位置，' : ''}
        地址未验证收件能力。
      </p>
      {children}
    </div>
  )
}
