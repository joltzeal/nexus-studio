import { PropertySheet } from '../../../shared/ui/peek'
import {
  patchDraft,
  patchForm,
  useProfileForm,
  type ProfileFormDraft,
} from '../model/useProfileForm'
import { ProxyRow } from './fields'
import { useWorkspace } from '../../../raccoon/store'

/// CloakBrowser's Proxy tab, on the same proxy picker and sheet as ShardBrowser.
export function CloakProxyTab({ draft }: { draft: ProfileFormDraft }) {
  const state = useWorkspace()
  const id = useProfileForm((s) => s.id)
  const profile = id ? state.profiles.find((row) => row.id === id) : null
  const keep =
    profile && profile.proxyMode !== 'direct'
      ? {
          id: profile.id,
          label: profile.proxyMode === 'plugin' ? '沿用当前插件代理' : '沿用当前代理',
        }
      : null
  return (
    <div className="flex flex-col gap-2">
      <PropertySheet>
        <div className="flex flex-col gap-[2px]">
          <ProxyRow
            value={draft.form.proxy_id}
            keep={keep}
            onChange={(proxy_id) => {
              patchDraft({ newProxyLine: '' })
              patchForm({ proxy_id })
            }}
            newLine={draft.newProxyLine}
            onNewLine={(newProxyLine) => patchDraft({ newProxyLine })}
          />
        </div>
      </PropertySheet>
    </div>
  )
}
