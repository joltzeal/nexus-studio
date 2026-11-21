import { ProfilePluginButtons } from '../PluginPanel/ProfilePluginButtons'

export function ProfilePluginCell({
  profileId,
  tabbable,
}: {
  profileId: string
  tabbable: boolean
}) {
  return <ProfilePluginButtons profileId={profileId} tabbable={tabbable} />
}
