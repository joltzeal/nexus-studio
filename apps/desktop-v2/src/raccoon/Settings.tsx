import { useNav } from '../shared/model/navigation'
import { useEffect, useRef, useState } from 'react'
import {
  Button,
  DialogModal,
  ProgressBar,
  SegmentControl,
  Switch,
  TabPanel,
  Tabs,
  useTheme,
  type Theme,
} from '@proxyshard/shardx-ui-kit'
import { PageBody, PageHeader } from '../widgets/PageHeader'
import { SettingRow, SettingsGroup } from '../pages/settings/SettingRow'
import { SaveBar } from '../pages/settings/SaveBar'
import { useUnsaved } from '../shared/model/unsaved'
import { nativeApi, nativeError } from './api'
import { workspace, useWorkspace } from './store'
import {
  loadNativeSettings,
  saveNativeSettings,
  useNativeSettings,
} from './settings-store'
import {
  workbenchSettingsApi,
  type WorkbenchSettings,
  type NetworkSettings,
} from './settings-api'
import {
  NativeGeneral,
  NativeProfileDefaults,
  NativeNetwork,
  NativeTags,
  NativeViews,
  NativeInfo,
} from './SettingsSections'
import { SelectField } from '../shared/ui/SelectField'
import { useInterfaceSize, INTERFACE_SIZES } from '../shared/model/interfaceSize'
import { useMotion } from '../shared/model/motion'
import { NativeAutomationApiSettings } from './automation/ApiSettings'
import { CloakBrowserLab } from './CloakBrowserLab'
import { AliasModeLab } from './AliasModeLab'
import { BitBrowserGuide, useBitBrowserLauncher } from './BitBrowserGuide'
import { useLabUnlock } from './app-meta'

type SettingsTab =
  | 'general'
  | 'profiles'
  | 'tags'
  | 'views'
  | 'api'
  | 'helper'
  | 'storage'
  | 'sync'
  | 'other'
  | 'about'
  | 'laboratory'
  | 'appearance'
type KernelAction = 'refresh' | 'download' | 'delete'

const settingsTabs = [
  { value: 'general', label: '通用' },
  { value: 'appearance', label: '外观' },
  { value: 'profiles', label: 'Profile 默认设置' },
  { value: 'tags', label: '标签' },
  { value: 'views', label: '视图' },
  { value: 'api', label: 'API' },
  { value: 'helper', label: '浏览器助手' },
  { value: 'storage', label: '存储' },
  { value: 'sync', label: '同步' },
  { value: 'other', label: '其他' },
  { value: 'laboratory', label: '实验室' },
  { value: 'about', label: '关于' },
]

const capabilityNotes: Partial<Record<SettingsTab, { title: string; help: string }>> = {
  helper: {
    title: '浏览器助手',
    help: 'ShardBrowser Helper 的身份资料和字段填充协议尚未接入 Raccoon。',
  },
  sync: {
    title: '同步与团队',
    help: '当前 Workspace 使用本机数据。ShardBrowser 团队服务器与云同步协议尚未接入。',
  },
}

async function refreshNativeStatus() {
  const results = await Promise.allSettled([
    workspace.loadKernels('shardbrowser'),
    workspace.refresh(),
  ])
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [nativeError(result.reason).message] : [],
  )
  if (errors.length > 0) throw new Error(errors.join('；'))
}

function NativeAppearance() {
  const { theme, setTheme } = useTheme()
  const size = useInterfaceSize((state) => state.choice)
  const reduce = useMotion((state) => state.reduce)
  return (
    <SettingsGroup>
      <SettingRow
        id="native-theme"
        title="主题"
        help="立即应用，作为当前界面的本地偏好保存。"
        control={({ labelId, helpId }) => (
          <SegmentControl
            fit
            size="xsmall"
            aria-labelledby={labelId}
            aria-describedby={helpId}
            value={theme}
            onChange={(value) => setTheme(value as Theme)}
            items={[
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
              { value: 'system', label: '跟随系统' },
            ]}
          />
        )}
      />
      <SettingRow
        id="native-interface-size"
        title="界面缩放"
        help="立即应用并保存当前窗口的显示偏好。"
        control={({ labelId }) => (
          <div className="w-[200px]">
            <SelectField
              aria-labelledby={labelId}
              value={size}
              options={[
                { value: 'auto' as const, label: '自动' },
                ...INTERFACE_SIZES.map((value) => ({ value, label: `${value}%` })),
              ]}
              onChange={(value) => useInterfaceSize.getState().setSize(value)}
            />
          </div>
        )}
      />
      <SettingRow
        id="native-reduce-motion"
        title="减少动态效果"
        help="立即保存并应用于当前界面。"
        control={({ labelId }) => (
          <Switch
            aria-labelledby={labelId}
            checked={reduce}
            onChange={(value) => useMotion.getState().setReduce(value)}
          />
        )}
      />
    </SettingsGroup>
  )
}

export function NativeSettingsPage() {
  const state = useWorkspace()
  const settings = useNativeSettings((state) => state.value)
  const settingsError = useNativeSettings((state) => state.error)
  const [draftSettings, setDraftSettings] = useState<WorkbenchSettings | null>(null)
  const [network, setNetwork] = useState<NetworkSettings | null>(null)
  const [draftNetwork, setDraftNetwork] = useState<NetworkSettings | null>(null)
  const [networkError, setNetworkError] = useState<string | null>(null)
  const connection = state.connections.find((row) => row.providerId === 'shardbrowser')
  const cloakConnection = state.connections.find(
    (row) => row.providerId === 'cloakbrowser',
  )
  const aliasConnection = state.connections.find((row) => row.providerId === 'aliasmode')
  const bitConnection = state.connections.find((row) => row.providerId === 'bitbrowser')
  const workspaceBitProbe =
    bitConnection && state.connectionId === bitConnection.id ? state.probe : null
  const savedCloakEnabled = cloakConnection?.enabled ?? false
  const savedEnabled = connection?.enabled ?? false
  const [labTab, setLabTab] = useState<'cloakbrowser' | 'aliasmode' | 'shardbrowser' | 'camoufox'>('cloakbrowser')
  const tab = useNav((state) => state.settingsTab) as SettingsTab
  const labUnlocked = useLabUnlock((state) => state.unlocked)
  const unlockLab = useLabUnlock((state) => state.unlock)
  const tabs = labUnlocked
    ? settingsTabs
    : settingsTabs.filter((row) => row.value !== 'laboratory')
  const setTab = (value: SettingsTab) => {
    void useNav.getState().openSettings(value)
  }
  useEffect(() => {
    if (tab === 'laboratory' && !labUnlocked) unlockLab()
  }, [tab, labUnlocked, unlockLab])
  const [draftEnabled, setDraftEnabled] = useState<boolean | null>(null)
  const [draftCloakEnabled, setDraftCloakEnabled] = useState<boolean | null>(null)
  const [draftAliasEnabled, setDraftAliasEnabled] = useState<boolean | null>(null)
  const [deleteBlocked, setDeleteBlocked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [kernelAction, setKernelAction] = useState<KernelAction | null>(null)
  const [kernelError, setKernelError] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [loadingKernels, setLoadingKernels] = useState(true)
  const [deleteVersion, setDeleteVersion] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [bitGroups, setBitGroups] = useState<{ id: string; name: string }[]>([])
  const [bitError, setBitError] = useState<string | null>(null)
  const [bitProbe, setBitProbe] = useState<typeof workspaceBitProbe>(workspaceBitProbe)
  const bitLauncher = useBitBrowserLauncher()
  const actionLock = useRef(false)
  const savingLock = useRef(false)
  const enabled = draftEnabled ?? savedEnabled
  const cloakEnabled = draftCloakEnabled ?? savedCloakEnabled
  const savedAliasEnabled = aliasConnection?.enabled ?? false
  const aliasEnabled = draftAliasEnabled ?? savedAliasEnabled
  // A failed save can already have persisted the switch before its readback
  // fails. Keep the draft and Save bar until a complete save succeeds.
  const settingsDirty =
    draftSettings !== null && JSON.stringify(draftSettings) !== JSON.stringify(settings)
  const networkDirty =
    draftNetwork !== null && JSON.stringify(draftNetwork) !== JSON.stringify(network)
  const cloakDirty =
    draftCloakEnabled !== null &&
    (cloakEnabled !== savedCloakEnabled || saveError !== null || saving)
  const dirty =
    settingsDirty ||
    networkDirty ||
    (draftEnabled !== null &&
      (enabled !== savedEnabled || saveError !== null || saving)) ||
    (draftAliasEnabled !== null &&
      (aliasEnabled !== savedAliasEnabled || saveError !== null || saving)) ||
    cloakDirty
  const currentSettings = draftSettings ?? settings
  const currentNetwork = draftNetwork ?? network
  const kernelBusy =
    loadingKernels || kernelAction !== null || state.kernels?.downloading === true
  const download = state.kernels?.download
  const downloading = kernelAction === 'download' || state.kernels?.downloading === true
  const phaseLabels = {
    idle: '等待下载开始',
    preparing: '正在准备',
    downloading: '正在下载',
    extracting: '正在解压',
    verifying: '正在校验',
    ready: '内核已安装',
    failed: '下载失败',
  }

  useEffect(() => {
    let active = true
    void workbenchSettingsApi.network().then(
      (value) => {
        if (active) {
          setNetwork(value)
          setNetworkError(null)
        }
      },
      (error) => {
        if (active) setNetworkError(nativeError(error).message)
      },
    )
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    setBitProbe(workspaceBitProbe)
  }, [workspaceBitProbe])

  useEffect(() => {
    if (!bitConnection?.enabled) {
      setBitProbe(null)
      return
    }
    let active = true
    const read = async () => {
      try {
        const value = await nativeApi.call('browser_connection_probe', {
          id: bitConnection.id,
        })
        if (active) {
          setBitProbe(value as NonNullable<typeof workspaceBitProbe>)
          setBitError(null)
        }
      } catch (error) {
        if (active) setBitError(nativeError(error).message)
      }
    }
    void read()
    const timer = setInterval(() => void read(), 3000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [bitConnection?.enabled, bitConnection?.id])

  useEffect(() => {
    if (!bitConnection?.enabled || !bitProbe?.connected) {
      setBitGroups([])
      return
    }
    let active = true
    void nativeApi.call('browser_group_list', { connectionId: bitConnection.id }).then(
      (value) => {
        if (!active || !Array.isArray(value)) return
        setBitGroups(
          value.flatMap((row) => {
            if (!row || typeof row !== 'object') return []
            const item = row as Record<string, unknown>
            return typeof item.id === 'string' && typeof item.name === 'string'
              ? [{ id: item.id, name: item.name }]
              : []
          }),
        )
        setBitError(null)
      },
      (error) => {
        if (active) setBitError(nativeError(error).message)
      },
    )
    return () => {
      active = false
    }
  }, [bitConnection?.enabled, bitConnection?.id, bitProbe?.connected])

  const saveBitGroup = async (defaultGroupId: string) => {
    if (!bitConnection || saving) return
    setBitError(null)
    try {
      await nativeApi.call('browser_connection_save', {
        input: {
          id: bitConnection.id,
          providerId: 'bitbrowser',
          name: bitConnection.name,
          endpoint: bitConnection.endpoint,
          apiKey: bitConnection.apiKey,
          defaultGroupId,
          scopeLabel: bitConnection.scopeLabel,
        },
      })
      await workspace.initialize(bitConnection.id)
    } catch (error) {
      setBitError(nativeError(error).message)
    }
  }

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        await workspace.loadKernels('shardbrowser')
        if (active) setStatusError(null)
      } catch (error) {
        if (active) setStatusError(nativeError(error).message)
      } finally {
        if (active) {
          setLoadingKernels(false)
          // Downloads started before opening Settings remain observable.
          if (kernelAction === 'download' || workspace.state.kernels?.downloading)
            timer = setTimeout(read, 1000)
        }
      }
    }
    void read()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [kernelAction, state.kernels?.downloading])

  const save = async () => {
    if (savingLock.current || actionLock.current) return false
    savingLock.current = true
    setSaving(true)
    setSaveError(null)
    try {
      // Confirm each completed write so a later failure keeps only the
      // remaining edits in the Save bar.
      if (settingsDirty && draftSettings) {
        await saveNativeSettings(draftSettings)
        setDraftSettings(null)
      }
      if (networkDirty && draftNetwork) {
        const saved = await workbenchSettingsApi.saveNetwork(draftNetwork)
        setNetwork(saved)
        setDraftNetwork(null)
        setNetworkError(null)
      }
      if (draftCloakEnabled !== null) {
        await workspace.enable('cloakbrowser', cloakEnabled)
        setDraftCloakEnabled(null)
      }
      if (draftAliasEnabled !== null) {
        const result = await nativeApi.call('browser_managed_aliasmode_set', { enabled: aliasEnabled })
        if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string') {
          throw new Error('AliasMode 接入保存回执无效')
        }
        await workspace.initialize(aliasEnabled ? result.id : null)
        setDraftAliasEnabled(null)
      }
      if (draftEnabled !== null) {
        await workspace.enable('shardbrowser', enabled)
        setDraftEnabled(null)
      }
      return true
    } catch (error) {
      setSaveError(nativeError(error).message)
      return false
    } finally {
      savingLock.current = false
      setSaving(false)
    }
  }

  const discard = () => {
    if (savingLock.current) return
    setDraftEnabled(null)
    setDraftCloakEnabled(null)
    setDraftAliasEnabled(null)
    setDraftSettings(null)
    setDraftNetwork(null)
    setSaveError(null)
  }
  useUnsaved(dirty ? { id: 'native-settings', label: '应用设置', save, discard } : null)

  const runKernelAction = async (action: KernelAction) => {
    if (actionLock.current || savingLock.current || loadingKernels) return
    if (action !== 'refresh' && workspace.state.kernels?.downloading) return
    if (action === 'delete' && !deleteVersion) return
    actionLock.current = true
    setKernelAction(action)
    setKernelError(null)
    setDeleteError(null)
    try {
      if (action === 'download') await nativeApi.call('shardbrowser_kernel_download')
      if (action === 'delete') {
        await nativeApi.call('shardbrowser_kernel_delete', { version: deleteVersion })
        setDeleteVersion(null)
      }
    } catch (error) {
      const message = nativeError(error).message
      if (action === 'delete') setDeleteError(message)
      else setKernelError(message)
    } finally {
      try {
        await refreshNativeStatus()
        setStatusError(null)
      } catch (error) {
        setStatusError(
          `状态刷新失败，所显示的信息可能已过期。${nativeError(error).message}`,
        )
      }
      actionLock.current = false
      setKernelAction(null)
    }
  }

  const closeDelete = () => {
    if (actionLock.current) return
    setDeleteVersion(null)
    setDeleteError(null)
  }

  return (
    <>
      <PageHeader title="应用设置" />
      <PageBody scrollKey={`native-settings:${tab}`}>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-start gap-6">
          <Tabs
            idBase="native-settings"
            aria-label="设置分类"
            orientation="vertical"
            className="sticky top-0"
            value={tab}
            onChange={(value) => setTab(value as SettingsTab)}
            items={tabs}
          />
          <TabPanel
            tabsId="native-settings"
            value={tab}
            className="flex min-w-0 flex-col gap-3.5"
          >
            <h2 className="m-0 text-panel-title text-text-strong-950">
              {tabs.find((row) => row.value === tab)?.label}
            </h2>
            {settingsError && (
              <div
                role="alert"
                className="flex items-center gap-2 text-help text-error-text"
              >
                <span>{settingsError}</span>
                <Button
                  size="3xsmall"
                  variant="neutral"
                  mode="stroke"
                  onClick={() => void loadNativeSettings().catch(() => {})}
                >
                  重新读取设置
                </Button>
              </div>
            )}
            {tab === 'general' && (
              <>
                <SettingsGroup title="默认浏览器">
                  {bitProbe && !bitProbe.connected ? (
                    <BitBrowserGuide variant="settings" />
                  ) : (
                    <>
                      <SettingRow
                        id="native-bitbrowser-status"
                        title="比特浏览器"
                        help={
                          bitConnection?.endpoint
                            ? `本地 API ${bitConnection.endpoint}`
                            : '随应用常开，需要先启动比特浏览器'
                        }
                        control={() => (
                          <Button
                            size="xsmall"
                            isLoading={bitLauncher.launching}
                            onClick={() => void bitLauncher.launch()}
                          >
                            打开比特浏览器
                          </Button>
                        )}
                        below={
                          bitError ? (
                            <p role="alert" className="m-0 text-help text-error-text">
                              {bitError}
                            </p>
                          ) : undefined
                        }
                      />
                      <SettingRow
                        id="native-bitbrowser-group"
                        title="默认分组"
                        help="新 Profile 创建到该分组"
                        control={({ labelId }) => (
                          <div className="w-[220px]">
                            <SelectField
                              aria-labelledby={labelId}
                              value={bitConnection?.defaultGroupId ?? ''}
                              disabled={bitGroups.length === 0 || saving}
                              options={[
                                {
                                  value: '',
                                  label: bitGroups.length ? '选择分组' : '暂无分组',
                                },
                                ...bitGroups.map((group) => ({
                                  value: group.id,
                                  label: group.name,
                                })),
                              ]}
                              onChange={(value) => {
                                if (value) void saveBitGroup(value)
                              }}
                            />
                          </div>
                        )}
                      />
                    </>
                  )}
                </SettingsGroup>
                {currentSettings ? (
                  <fieldset disabled={saving} className="m-0 min-w-0 border-0 p-0">
                    <NativeGeneral value={currentSettings} change={setDraftSettings} />
                  </fieldset>
                ) : (
                  <p role="status">正在读取设置</p>
                )}
              </>
            )}
            {tab === 'profiles' && currentSettings && (
              <fieldset disabled={saving} className="m-0 min-w-0 border-0 p-0">
                <NativeProfileDefaults
                  value={currentSettings}
                  change={setDraftSettings}
                />
              </fieldset>
            )}
            {tab === 'tags' && <NativeTags key={state.connectionId} />}
            {tab === 'views' && <NativeViews key={state.connectionId} />}
            {tab === 'storage' && <NativeInfo storage />}
            {tab === 'about' && <NativeInfo storage={false} />}
            {tab === 'api' && <NativeAutomationApiSettings />}
            {capabilityNotes[tab] && (
              <SettingsGroup>
                <SettingRow
                  id={`native-capability-${tab}`}
                  title={capabilityNotes[tab].title}
                  help={capabilityNotes[tab].help}
                />
              </SettingsGroup>
            )}
            {tab === 'other' && (
              <>
                {currentNetwork && (
                  <fieldset disabled={saving} className="m-0 min-w-0 border-0 p-0">
                    <NativeNetwork value={currentNetwork} change={setDraftNetwork} />
                  </fieldset>
                )}
                {networkError && (
                  <div
                    role="alert"
                    className="flex items-center gap-2 text-help text-error-text"
                  >
                    <span>{networkError}</span>
                    <Button
                      size="3xsmall"
                      variant="neutral"
                      mode="stroke"
                      onClick={() =>
                        void workbenchSettingsApi.network().then(
                          (value) => {
                            setNetwork(value)
                            setNetworkError(null)
                          },
                          (error) => setNetworkError(nativeError(error).message),
                        )
                      }
                    >
                      重试读取
                    </Button>
                  </div>
                )}
              </>
            )}
            {tab === 'appearance' && <NativeAppearance />}
            {tab === 'laboratory' && (
              <>
                <Tabs
                  idBase="native-laboratory"
                  aria-label="实验浏览器"
                  value={labTab}
                  onChange={(value) => setLabTab(value as typeof labTab)}
                  items={[
                    { value: 'cloakbrowser', label: 'CloakBrowser' },
                    { value: 'aliasmode', label: 'AliasMode' },
                    { value: 'shardbrowser', label: 'ShardBrowser' },
                    { value: 'camoufox', label: 'Camoufox' },
                  ]}
                />
                {labTab === 'cloakbrowser' && <TabPanel
                  tabsId="native-laboratory"
                  value="cloakbrowser"
                  className="flex min-w-0 flex-col gap-3.5"
                >
                  <CloakBrowserLab
                    connection={cloakConnection}
                    savedEnabled={savedCloakEnabled}
                    enabled={cloakEnabled}
                    saving={saving}
                    probe={
                      state.connectionId === cloakConnection?.id ? state.probe : null
                    }
                    onToggle={(value) => {
                      setDraftCloakEnabled(value)
                      setSaveError(null)
                    }}
                    onBlockChange={setDeleteBlocked}
                  />
                </TabPanel>}
                {labTab === 'aliasmode' && <TabPanel
                  tabsId="native-laboratory"
                  value="aliasmode"
                  className="flex min-w-0 flex-col gap-3.5"
                >
                  <AliasModeLab
                    connectionEnabled={savedAliasEnabled}
                    enabled={aliasEnabled}
                    saving={saving}
                    probe={state.connectionId === aliasConnection?.id ? state.probe : null}
                    onToggle={(value) => {
                      setDraftAliasEnabled(value)
                      setSaveError(null)
                    }}
                  />
                </TabPanel>}
                {labTab === 'camoufox' && <TabPanel
                  tabsId="native-laboratory"
                  value="camoufox"
                  className="flex min-w-0 flex-col gap-3.5"
                >
                  <SettingsGroup title="Camoufox">
                    <SettingRow id="native-camoufox-status" title="Provider 状态" help="Camoufox 是占位 Provider。连接、内核和 Profile 生命周期完成接入后才会开放。" control={() => <span className="text-help text-text-soft-400">暂不可用</span>} />
                    <SettingRow id="native-camoufox-create" title="Profile 创建" help="当前不会创建或启动 Camoufox Profile。" control={() => <span className="text-help text-text-soft-400">未开放</span>} />
                  </SettingsGroup>
                </TabPanel>}
                {labTab === 'shardbrowser' && <TabPanel
                  tabsId="native-laboratory"
                  value="shardbrowser"
                  className="flex min-w-0 flex-col gap-3.5"
                >
                  <SettingsGroup title="ShardBrowser">
                    <SettingRow
                      id="native-shardbrowser-enable"
                      title="启用 ShardBrowser"
                      help="保存后更新浏览器接入和 Workspace 列表。"
                      control={({ labelId, helpId }) => (
                        <Switch
                          aria-labelledby={labelId}
                          aria-describedby={helpId}
                          checked={enabled}
                          disabled={saving || kernelAction !== null || state.loading}
                          onChange={(value) => {
                            setDraftEnabled(value)
                            setSaveError(null)
                          }}
                        />
                      )}
                    />
                    <SettingRow
                      id="native-shardbrowser-connection"
                      title="已保存的接入状态"
                      help={state.error ?? (savedEnabled ? '已启用' : '未启用')}
                      below={
                        savedEnabled &&
                        state.probe &&
                        state.connectionId === connection?.id ? (
                          <p className="m-0 text-help text-text-sub-600" role="status">
                            {state.probe.connected ? '接入探测可达' : '接入探测不可达'}
                            {state.probe.message ? ` · ${state.probe.message}` : ''}
                          </p>
                        ) : undefined
                      }
                    />
                  </SettingsGroup>
                  <SettingsGroup title="本地内核">
                    <SettingRow
                      id="native-shardbrowser-kernel-status"
                      title="内核状态"
                      help={
                        loadingKernels
                          ? '正在读取本地清单'
                          : state.kernels
                            ? `平台 ${state.kernels.platform}${state.kernels.downloading ? ' · 正在下载' : ''}`
                            : '本地清单尚未读取成功'
                      }
                      control={() => (
                        <Button
                          size="xsmall"
                          variant="neutral"
                          mode="stroke"
                          disabled={loadingKernels || kernelAction !== null || saving}
                          isLoading={kernelAction === 'refresh'}
                          onClick={() => void runKernelAction('refresh')}
                        >
                          刷新状态
                        </Button>
                      )}
                      below={
                        <div className="flex flex-col gap-1.5" aria-live="polite">
                          {statusError && (
                            <p role="alert" className="m-0 text-help text-error-text">
                              {statusError}
                            </p>
                          )}
                          {kernelError && (
                            <p role="alert" className="m-0 text-help text-error-text">
                              {kernelError}
                            </p>
                          )}
                          {!kernelError && download?.error && (
                            <p role="alert" className="m-0 text-help text-error-text">
                              {download.error}
                            </p>
                          )}
                        </div>
                      }
                    />
                    <SettingRow
                      id="native-shardbrowser-download"
                      title="下载官方内核"
                      help="下载适用于当前平台的官方内核，完成后重新读取本地清单。"
                      control={() => (
                        <Button
                          size="xsmall"
                          disabled={
                            kernelBusy ||
                            saving ||
                            state.kernels === null ||
                            statusError !== null
                          }
                          isLoading={kernelAction === 'download'}
                          onClick={() => void runKernelAction('download')}
                        >
                          {kernelAction === 'download' || state.kernels?.downloading
                            ? '正在下载'
                            : '下载内核'}
                        </Button>
                      )}
                      below={
                        downloading ? (
                          <div className="flex flex-col gap-1.5">
                            <p role="status" className="m-0 text-help text-text-sub-600">
                              {download && state.kernels?.downloading
                                ? phaseLabels[download.phase]
                                : '正在等待下载结果'}
                              {download?.label && state.kernels?.downloading
                                ? ` · ${download.label}`
                                : ''}
                            </p>
                            {download?.phase === 'downloading' &&
                            download.percent !== null ? (
                              <ProgressBar
                                aria-label="ShardBrowser 内核下载进度"
                                value={download.percent}
                                showValue
                              />
                            ) : (
                              <progress
                                aria-label="ShardBrowser 内核准备进度"
                                className="h-1.5 w-full accent-primary-base"
                              />
                            )}
                            {download?.phase === 'downloading' && (
                              <p className="m-0 text-help tabular-nums text-text-sub-600">
                                {(download.receivedBytes / 1024 / 1024).toFixed(1)} MiB
                                {download.totalBytes !== null
                                  ? ` / ${(download.totalBytes / 1024 / 1024).toFixed(1)} MiB`
                                  : ' · 总大小未知'}
                              </p>
                            )}
                          </div>
                        ) : undefined
                      }
                    />
                    {state.kernels?.installed.map((kernel) => (
                      <SettingRow
                        key={kernel.version}
                        id={`native-kernel-${kernel.version}`}
                        title={kernel.version}
                        help="已安装"
                        control={() => (
                          <Button
                            size="xsmall"
                            variant="error"
                            mode="ghost"
                            aria-label={`删除内核 ${kernel.version}`}
                            disabled={kernelBusy || saving || statusError !== null}
                            onClick={() => {
                              setDeleteError(null)
                              setDeleteVersion(kernel.version)
                            }}
                          >
                            删除
                          </Button>
                        )}
                      />
                    ))}
                    {state.kernels?.installed.length === 0 && (
                      <SettingRow
                        id="native-kernels-empty"
                        title="尚未安装内核"
                        help="下载完成后可在此查看已安装版本。"
                      />
                    )}
                  </SettingsGroup>
                </TabPanel>}
              </>
            )}
          </TabPanel>
        </div>
      </PageBody>
      <SaveBar
        dirty={dirty}
        saving={saving}
        error={saveError}
        held={kernelAction !== null || deleteBlocked ? '请等待内核操作完成' : null}
        onSave={() => void save()}
        onDiscard={discard}
      />
      <DialogModal
        open={deleteVersion !== null}
        onClose={closeDelete}
        title="删除 ShardBrowser 内核"
        subtitle={`确认删除版本 ${deleteVersion ?? ''}？仍被 Profile 绑定的版本将由原生服务拒绝删除。`}
        confirmLabel="删除内核"
        confirmVariant="error"
        cancelLabel="取消"
        onCancel={closeDelete}
        isLoading={kernelAction === 'delete'}
        isDisabled={
          kernelAction !== null || saving || state.kernels?.downloading === true
        }
        onConfirm={() => void runKernelAction('delete')}
        footerNote={
          deleteError ? (
            <span role="alert" className="text-error-text">
              {deleteError}
            </span>
          ) : undefined
        }
      />
    </>
  )
}
