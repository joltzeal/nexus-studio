import { useState, type RefObject } from 'react'
import { Input } from '@proxyshard/shardx-ui-kit'
import { PropertySheet } from '../../../shared/ui/peek'
import {
  addTagName,
  patchBit,
  patchDraft,
  patchForm,
  problemsOf,
  useProfileForm,
  type ProfileFormDraft,
} from '../model/useProfileForm'
import { FolderField } from './FolderField'
import { ColorRow, NotesRow } from './fields'
import { TagsField } from './TagsField'
import { teamRefusal } from '../../../entities/space'

export function BitBasicsTab({
  draft,
  nameRef,
}: {
  draft: ProfileFormDraft
  nameRef: RefObject<HTMLInputElement | null>
}) {
  const tried = useProfileForm((s) => s.tried)
  const keep = useProfileForm((s) => s.saved?.folder)
  const [blurred, setBlurred] = useState(false)
  const problems = problemsOf(draft)
  const bit = draft.bit!
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
      <div className="grid grid-cols-2 gap-[12px]">
        <Input
          label="内核版本"
          inputSize="xsmall"
          wrapperClassName="gap-[6px]"
          placeholder="例如 130"
          aria-invalid={!!problems.bit?.kernel || undefined}
          value={bit.kernel}
          error={tried ? problems.bit?.kernel : undefined}
          onChange={(event) => patchBit({ kernel: event.target.value })}
        />
        <Input
          label="起始地址"
          inputSize="xsmall"
          wrapperClassName="gap-[6px]"
          inputMode="url"
          placeholder="https://example.com"
          aria-invalid={!!problems.bit?.startUrl || undefined}
          value={bit.startUrl}
          error={tried ? problems.bit?.startUrl : undefined}
          onChange={(event) => patchBit({ startUrl: event.target.value })}
        />
      </div>
    </div>
  )
}
