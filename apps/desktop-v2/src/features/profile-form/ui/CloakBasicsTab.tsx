import { useState, type RefObject } from 'react'
import { Input } from '@proxyshard/shardx-ui-kit'
import { PropertySheet } from '../../../shared/ui/peek'
import { SelectField } from '../../../shared/ui/SelectField'
import { addTagName } from '../model/useProfileForm'
import {
  patchCloak,
  patchDraft,
  patchForm,
  problemsOf,
  useProfileForm,
  type ProfileFormDraft,
} from '../model/useProfileForm'
import { FolderField } from './FolderField'
import { ColorRow, NotesRow } from './fields'
import { TagsField } from './TagsField'
import { useWorkspace } from '../../../raccoon/store'
import { teamRefusal } from '../../../entities/space'

/// CloakBrowser's Basics: the same name field, property sheet, Folder, tags,
/// colour, notes and Cookies as a ShardBrowser profile, then its fixed kernel
/// and start URL.
export function CloakBasicsTab({
  draft,
  nameRef,
}: {
  draft: ProfileFormDraft
  nameRef: RefObject<HTMLInputElement | null>
}) {
  const state = useWorkspace()
  const tried = useProfileForm((s) => s.tried)
  const mode = useProfileForm((s) => s.mode)
  const keep = useProfileForm((s) => s.saved?.folder)
  const [blurred, setBlurred] = useState(false)
  const problems = problemsOf(draft)
  const cloak = draft.cloak!
  const kernels = state.cloakKernels?.installed ?? []
  const kernelOptions = [
    ...(mode === 'create' ? [{ value: '__latest' as string, label: '最新稳定版' }] : []),
    ...kernels.map((row) => ({ value: row.version as string, label: row.version })),
  ]
  const kernelValue = cloak.kernel || kernels[0]?.version || ''
  const shownKernelOptions = !kernelValue
    ? [{ value: '', label: '未绑定' }]
    : !kernelOptions.some((option) => option.value === kernelValue)
      ? [...kernelOptions, { value: kernelValue, label: kernelValue }]
      : kernelOptions
  return (
    <div className="flex flex-col gap-4">
      <Input
        ref={nameRef}
        label="名称"
        inputSize="xsmall"
        wrapperClassName="gap-[6px]"
        required
        maxLength={40}
        aria-invalid={!!problems.name || undefined}
        value={draft.form.name}
        error={problems.name && (blurred || tried) ? problems.name : undefined}
        onChange={(event) => patchForm({ name: event.target.value })}
        onBlur={() => setBlurred(true)}
      />
      <PropertySheet>
        <div className="flex flex-col gap-[2px]">
          <div className="flex flex-col gap-[2px]">
            <FolderField
              value={draft.folder}
              keep={keep}
              onChange={(folder) => patchDraft({ folder })}
            />
            <TagsField
              value={draft.tagIds}
              newNames={draft.newTags}
              onChange={(tagIds) => patchDraft({ tagIds })}
              onNewNamesChange={(newTags) => patchDraft({ newTags })}
              onCreate={teamRefusal('create') ? undefined : addTagName}
            />
          </div>
          <ColorRow value={draft.form.color} onChange={(color) => patchForm({ color })} />
          <NotesRow value={draft.form.notes} onChange={(notes) => patchForm({ notes })} />
        </div>
      </PropertySheet>
      <SelectField
        label="CloakBrowser 内核"
        value={kernelValue}
        onChange={(kernel) => {
          if (mode === 'create') patchCloak({ kernel })
        }}
        options={shownKernelOptions}
        disabled={mode === 'edit'}
        placeholder={mode === 'create' ? '请选择内核版本' : undefined}
      />
      {mode === 'create' && problemOfKernel(problems) && (
        <p className="m-0 text-help text-error-text">{problems.cloak?.kernel}</p>
      )}
      <Input
        label="起始地址"
        inputSize="xsmall"
        wrapperClassName="gap-[6px]"
        inputMode="url"
        placeholder="https://example.com"
        aria-invalid={!!problems.cloak?.startUrl || undefined}
        value={cloak.startUrl}
        error={tried ? problems.cloak?.startUrl : undefined}
        onChange={(event) => patchCloak({ startUrl: event.target.value })}
      />
    </div>
  )
}

function problemOfKernel(problems: ReturnType<typeof problemsOf>): boolean {
  return !!problems.cloak?.kernel
}
