import { useRef, useState, type FormEvent } from 'react'
import { Check, Loader2, Pencil, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FieldError } from '@/components/ui/field'
import { toast } from '@/components/ui/toast'
import { updateNativeProfileNote } from '@/lib/platform/native-profiles'

export function WindowNote({
  id,
  name,
  note,
  onSaved,
}: {
  id: string
  name: string
  note: string
  onSaved: (note: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)

  async function save(event: FormEvent) {
    event.preventDefault()
    if (pending.current) return
    if (draft.trim() === note) {
      setEditing(false)
      return
    }
    pending.current = true
    setSaving(true)
    setError(null)
    try {
      const saved = await updateNativeProfileNote(id, draft)
      onSaved(saved)
      setEditing(false)
      toast.success('备注已保存')
    } catch (cause) {
      setError(
        typeof cause === 'string'
          ? cause
          : cause instanceof Error
            ? cause.message
            : '备注保存失败，请重试。',
      )
    } finally {
      pending.current = false
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="window-note-trigger"
        aria-label={`编辑 ${name} 的备注`}
        title={note || '添加备注'}
        onClick={() => {
          setDraft(note)
          setError(null)
          setEditing(true)
        }}
      >
        <span>{note || '添加备注'}</span>
        <Pencil aria-hidden="true" />
      </button>
    )
  }

  return (
    <form className="window-note-form" onSubmit={(event) => void save(event)}>
      <div className="window-note-controls">
        <Input
          autoFocus
          aria-label={`${name} 的备注`}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : `note-error-${id}`}
          placeholder="添加备注"
          maxLength={120}
          value={draft}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              if (event.key === 'Enter') event.preventDefault()
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              if (!pending.current) setEditing(false)
            }
          }}
        />
        <Button
          type="submit"
          size="icon-xs"
          variant="ghost"
          disabled={saving}
          aria-label={`保存 ${name} 的备注`}
        >
          {saving ? <Loader2 className="animate-spin" /> : <Check />}
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={saving}
          aria-label={`取消编辑 ${name} 的备注`}
          onClick={() => setEditing(false)}
        >
          <X />
        </Button>
      </div>
      {error === null ? null : (
        <FieldError id={`note-error-${id}`} role="alert">
          {error}
        </FieldError>
      )}
    </form>
  )
}
