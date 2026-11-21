import { useEffect } from 'react'
import {
  useLatched,
  usePresence,
  Button,
  IconButton,
  type Presence,
} from '@proxyshard/shardx-ui-kit'
import { ProfilePeek } from '../ProfilePeek'
import { useProfile, useProfileUi } from '../../entities/profile'
import { PeekBody, PeekHeader, PeekPanel } from '../../shared/ui/peek'
import { pluginUi, usePluginUi } from '../../raccoon/plugins/ui-store'
import { usePluginCatalog } from '../../raccoon/plugins/catalog'
import { useWorkspace } from '../../raccoon/store'
import { confirmLeave } from '../../shared/model/unsaved'
import { focusProfileRow } from '../../shared/lib/focusRow'
import { pluginUiIdentity } from '../../raccoon/plugins/ui-session'
import { PeekIcon } from '../../shared/icons'
import { PluginViewRenderer } from './PluginViewRenderer'

export function ProfileSidePanel() {
  const panel = usePluginUi()
  const peekId = useProfileUi((state) => state.peekId)
  const profiles = useProfile((state) => state.profiles)
  const plugins = usePluginCatalog((state) => state.plugins)
  const { connectionId } = useWorkspace()
  const presence = usePresence(
    panel.target ? `${panel.target.pluginId}:${panel.target.profileId}` : null,
    { maxExitMs: 250 },
  )
  useEffect(() => {
    const target = pluginUi.snapshot().target
    if (!target) return
    const plugin = plugins.find((item) => item.id === target.pluginId)
    if (peekId !== target.profileId) {
      pluginUi.close()
      return
    }
    if (
      connectionId !== target.connectionId ||
      !profiles.some((profile) => profile.id === target.profileId) ||
      !plugin?.enabled ||
      plugin.state !== 'running' ||
      pluginUiIdentity(plugin) !== target.identity
    ) {
      pluginUi.close()
      useProfileUi.getState().closePeek()
    }
  }, [peekId, profiles, plugins, connectionId])
  useEffect(() => () => pluginUi.close(), [])
  return presence.mounted ? <PluginPanel presence={presence} /> : <ProfilePeek />
}

function PluginPanel({ presence }: { presence: Presence<unknown> }) {
  const panel = usePluginUi()
  const shown = useLatched(panel.target ? panel : null)
  const profiles = useProfile((state) => state.profiles)
  if (!presence.mounted || !shown?.target) return null
  const target = shown.target
  const profile = profiles.find((item) => item.id === target.profileId)
  const close = () => {
    void confirmLeave().then((ok) => {
      if (!ok || pluginUi.snapshot().target !== target) return
      pluginUi.close()
      useProfileUi.getState().closePeek()
      focusProfileRow(target.profileId)
    })
  }
  const feedback = (
    <>
      {shown.error && (
        <div className="p-inset">
          <p role="alert" className="text-secondary text-error-text">
            {shown.error}
          </p>
          <Button
            size="xsmall"
            variant="neutral"
            mode="stroke"
            disabled={shown.busy}
            onClick={() => {
              void confirmLeave().then((ok) => {
                if (ok && pluginUi.snapshot().target === target)
                  void pluginUi.open(target)
              })
            }}
          >
            重新打开
          </Button>
        </div>
      )}
      {!shown.view && shown.busy && (
        <p role="status" className="p-inset text-secondary text-text-sub-600">
          正在读取插件内容
        </p>
      )}
    </>
  )
  return (
    <PeekPanel kind="plugin" label={shown.view?.title ?? '插件'} presence={presence}>
      <PeekHeader
        subject={`${target.pluginId}:${target.profileId}`}
        title={
          <h2 className="m-0 min-w-0 truncate text-panel-title text-text-strong-950">
            {shown.view?.title ?? '插件'} / {profile?.name}
          </h2>
        }
        extra={
          <IconButton
            size="3xsmall"
            label="返回 Profile 详情"
            icon={<PeekIcon className="size-3.5" />}
            onClick={() => {
              void confirmLeave().then((ok) => {
                if (ok && pluginUi.snapshot().target === target) pluginUi.close()
              })
            }}
          />
        }
        menuLabel="插件操作"
        closeLabel="关闭插件面板"
        closeShortcut="Esc"
        onClose={close}
      />
      {shown.view ? (
        <PluginViewRenderer
          key={shown.view.revision}
          view={shown.view}
          target={target}
          busy={shown.busy}
          notice={feedback}
          dispatch={async (id, values) =>
            (await pluginUi.dispatch(id, values)) ? pluginUi.snapshot().view : null
          }
        />
      ) : (
        <PeekBody>{feedback}</PeekBody>
      )}
    </PeekPanel>
  )
}
