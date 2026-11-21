import { cn, IconButton } from '@proxyshard/shardx-ui-kit'
import { useRef } from 'react'
import { usePluginCatalog } from '../../raccoon/plugins/catalog'
import { pluginUi, usePluginUi } from '../../raccoon/plugins/ui-store'
import { pluginUiIdentity } from '../../raccoon/plugins/ui-session'
import { useWorkspace, workspace } from '../../raccoon/store'
import { isNativeRaccoon } from '../../raccoon/runtime'
import { useProfile, useProfileUi } from '../../entities/profile'
import { confirmLeave } from '../../shared/model/unsaved'
import { useT } from '../../shared/i18n'
import type { PluginView } from '../../raccoon/plugins/types'
import { usePluginProfileStatus } from '../../raccoon/plugins/ui-profile-store'

const TONE = {
  neutral: 'text-text-sub-600',
  success: 'text-success-text',
  warning: 'text-warning-text',
  danger: 'text-error-text',
  info: 'text-information-text',
}

export function ProfilePluginButtons({
  profileId,
  tabbable = true,
  className,
}: {
  profileId: string
  tabbable?: boolean
  className?: string
}) {
  const t = useT()
  const plugins = usePluginCatalog((state) => state.plugins)
  const { connectionId } = useWorkspace()
  if (!isNativeRaccoon()) return null
  const entries = plugins.flatMap((plugin) => {
    const entry = plugin.ui?.profileTable
    return plugin.enabled && plugin.state !== 'available' && entry
      ? [{ plugin, entry }]
      : []
  })
  if (!entries.length) return null
  return (
    <div
      role="group"
      aria-label={t('profileTable.colPlugins')}
      className={cn('flex min-w-0 items-center gap-1 overflow-x-auto', className)}
      data-plugin-icons
    >
      {entries.map(({ plugin, entry }) => (
        <ProfilePluginButton
          key={plugin.id}
          plugin={plugin}
          entry={entry}
          profileId={profileId}
          connectionId={connectionId}
          tabbable={tabbable}
        />
      ))}
    </div>
  )
}

function ProfilePluginButton({
  plugin,
  entry,
  profileId,
  connectionId,
  tabbable,
}: {
  plugin: PluginView
  entry: NonNullable<NonNullable<PluginView['ui']>['profileTable']>
  profileId: string
  connectionId: string | null
  tabbable: boolean
}) {
  const panel = usePluginUi()
  const ref = useRef<HTMLButtonElement>(null)
  const ready =
    plugin.state === 'running' &&
    plugin.granted.includes(entry.capability) &&
    ['ui.view.open', 'ui.view.dispatch', 'ui.view.close'].every((method) =>
      plugin.methods.includes(method),
    )
  const status = usePluginProfileStatus(
    {
      pluginId: plugin.id,
      viewId: entry.viewId,
      connectionId: connectionId ?? '',
      identity: pluginUiIdentity(plugin),
    },
    profileId,
    ready && !!connectionId && plugin.methods.includes('ui.profile.status'),
    ref,
  )
  return (
    <IconButton
      ref={ref}
      size="3xsmall"
      label={
        ready
          ? status
            ? `${entry.title} · ${status.label}`
            : entry.title
          : `${entry.title}（暂不可用）`
      }
      aria-pressed={
        panel.target?.pluginId === plugin.id && panel.target.profileId === profileId
      }
      tabIndex={tabbable ? 0 : -1}
      disabled={!ready || !connectionId}
      data-plugin-id={plugin.id}
      tooltipWarm={false}
      icon={
        <svg
          viewBox={entry.icon.viewBox}
          className={cn('size-3.5', status && TONE[status.tone])}
          fill="currentColor"
          aria-hidden="true"
        >
          {entry.icon.paths.map((path, index) => (
            <path key={index} d={path} />
          ))}
        </svg>
      }
      onClick={(event) => {
        event.stopPropagation()
        const scope = connectionId
        void confirmLeave().then((ok) => {
          if (!ok || !scope || workspace.state.connectionId !== scope) return
          const latest = usePluginCatalog
            .getState()
            .plugins.find((item) => item.id === plugin.id)
          if (
            !latest?.enabled ||
            latest.state !== 'running' ||
            pluginUiIdentity(latest) !== pluginUiIdentity(plugin) ||
            !useProfile.getState().profiles.some((profile) => profile.id === profileId)
          )
            return
          useProfileUi.getState().openPeek(profileId)
          void pluginUi.open({
            pluginId: plugin.id,
            viewId: entry.viewId,
            profileId,
            connectionId: scope,
            identity: pluginUiIdentity(plugin),
          })
        })
      }}
    />
  )
}
