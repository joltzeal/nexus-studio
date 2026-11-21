import { Button, usePresence } from '@proxyshard/shardx-ui-kit'
import { useProfileUi } from '../entities/profile/lib/useProfileUi'
import { PeekBody, PeekHeader, PeekPanel, PeekSection } from '../shared/ui/peek'
import { openNativeEditor, useWorkspace } from './store'
import { useProxy } from '../entities/proxy/lib/useProxy'
import { usePoolProxyLabel } from '../features/manage-profiles/ui/ProxyChoiceList'
import { profileProxyChoice } from './profile-proxy'

export function NativeProfileDetails() {
  const state = useWorkspace()
  const id = useProfileUi((s) => s.peekId)
  const close = useProfileUi((s) => s.closePeek)
  const profile = state.profiles.find((row) => row.id === id)
  const proxies = useProxy((store) => store.proxies)
  const poolLabel = usePoolProxyLabel(profile ? profileProxyChoice(profile) : null)
  const presence = usePresence(profile?.id ?? null, { maxExitMs: 250 })
  if (!presence.mounted || !profile) return null
  const folder = state.folders.find((row) => row.id === profile.groupId)
  const fingerprint = profile.settings.shardbrowser
  const bit = profile.settings.bitbrowser
  const navigator = fingerprint?.navigator
  const text = (value: unknown, fallback = '自动') =>
    typeof value === 'string' && value && value !== 'auto' ? value : fallback
  const language =
    navigator && typeof navigator === 'object' && !Array.isArray(navigator)
      ? navigator.language
      : undefined
  const properties = [
    ['Profile ID', profile.id],
    [
      'Workspace',
      state.connections.find((row) => row.id === profile.connectionId)?.name ??
        profile.connectionId,
    ],
    ['保存状态', '已持久化'],
    [
      '运行状态',
      {
        stopped: '已停止',
        running: '运行中',
        starting: '启动中',
        stopping: '停止中',
        unknown: '状态未知',
        missing: '环境暂不可见',
      }[profile.state],
    ],
    ['Folder', folder?.name ?? '无'],
    ['内核版本', profile.kernelVersion ?? '—'],
    ['指纹种子', String(profile.settings.fingerprintSeed ?? '—')],
    [
      '代理来源',
      { direct: '直连', manual: '手动代理', plugin: '插件代理', provider: '厂商管理' }[
        profile.proxyMode
      ],
    ],
    ...(profile.proxyId
      ? [
          [
            '全局代理',
            proxies.find((entry) => entry.id === profile.proxyId)?.name || '代理暂不可用',
          ],
        ]
      : []),
    ...(poolLabel ? [['代理池端点', poolLabel]] : []),
    ['时区', text(fingerprint?.timezone ?? profile.settings.timezone)],
    ['语言', text(language ?? profile.settings.locale)],
    ...(bit
      ? [
          ['平台身份', text(bit.os, '自动')],
          ['GPU', text(bit.webglRender ?? bit.webglManufacturer, '自动')],
        ]
      : []),
    ['起始地址', profile.settings.startUrl || '默认'],
    ['备注', profile.settings.note || '—'],
  ]
  return (
    <PeekPanel kind="profile" label={profile.name} presence={presence}>
      <PeekHeader
        subject={profile.id}
        title={
          <h2 className="m-0 truncate text-panel-title text-text-strong-950">
            {profile.name}
          </h2>
        }
        extra={
          <Button
            size="3xsmall"
            mode="stroke"
            variant="neutral"
            disabled={profile.state !== 'stopped' || state.busy.has(profile.id)}
            onClick={() => openNativeEditor(profile.id)}
          >
            编辑
          </Button>
        }
        onClose={close}
        closeLabel="关闭详情"
        menuLabel="更多操作"
      />
      <PeekBody>
        <PeekSection id="native-profile" title="Profile 资料">
          <dl className="m-0 flex flex-col gap-3">
            {properties.map(([label, value]) => (
              <div
                key={label}
                className="grid grid-cols-[90px_minmax(0,1fr)] gap-3 text-secondary"
              >
                <dt className="text-text-sub-600">{label}</dt>
                <dd className="m-0 break-all text-text-strong-950">{value}</dd>
              </div>
            ))}
          </dl>
        </PeekSection>
      </PeekBody>
    </PeekPanel>
  )
}
