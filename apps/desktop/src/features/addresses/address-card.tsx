import { Bookmark, Check, Copy, Link2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { addressText, profileText, sourceLabel, streetLine, type Profile } from './types'

export interface AddressCardProps {
  profile: Profile
  busy: boolean
  onCopy: (text: string) => void
  onDelete: (id: string) => void
  saved?: boolean
  deleteLabel?: string
  onSave?: (profile: Profile) => void
  onLink?: (profile: Profile) => void
}

export function AddressCard({
  profile,
  busy,
  onCopy,
  onDelete,
  saved = false,
  deleteLabel = '删除这条地址',
  onSave,
  onLink,
}: AddressCardProps) {
  const fields: Array<{ label: string; value: string }> = [
    { label: '街道地址', value: streetLine(profile) },
    { label: '城市', value: profile.city },
    { label: '邮编', value: profile.postalCode },
    { label: '州 / 地区', value: profile.state ?? '' },
    { label: '名', value: profile.firstName },
    { label: '姓', value: profile.lastName },
    { label: 'username', value: profile.username },
  ]

  return (
    <article className="address-card" data-testid="address-card">
      <header className="address-card-head">
        <div>
          <p className="address-card-name">
            {profile.firstName} {profile.lastName}
          </p>
          <p className="address-handle">{profile.username}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={deleteLabel}
          disabled={busy}
          onClick={() => onDelete(profile.id)}
        >
          <Trash2 />
        </Button>
      </header>
      <p className="address-card-text">{addressText(profile)}</p>
      <dl className="address-fields">
        {fields.map(({ label, value }) => (
          <div key={label} className="address-field">
            <div>
              <dt>{label}</dt>
              <dd>{value === '' ? '—' : value}</dd>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={value === ''}
              aria-label={`复制${label}`}
              onClick={() => onCopy(value)}
            >
              <Copy data-icon="inline-start" />
              复制
            </Button>
          </div>
        ))}
      </dl>
      <footer className="address-card-foot">
        {onSave ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || saved}
            onClick={() => onSave(profile)}
          >
            {saved ? (
              <Check data-icon="inline-start" />
            ) : (
              <Bookmark data-icon="inline-start" />
            )}
            {saved ? '已保存' : '保存地址'}
          </Button>
        ) : null}
        {onLink ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onLink(profile)}
          >
            <Link2 data-icon="inline-start" />
            关联账号
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={() => onCopy(profileText(profile))}>
          复制资料
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onCopy(profile.username)}>
          复制 username
        </Button>
        {profile.sourceUrl === '' ? (
          <span className="address-source">{sourceLabel(profile.source)}</span>
        ) : (
          <a
            className="address-source"
            href={profile.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {sourceLabel(profile.source)} · 查看来源
          </a>
        )}
      </footer>
    </article>
  )
}
