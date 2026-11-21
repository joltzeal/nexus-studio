import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, cn } from '@proxyshard/shardx-ui-kit'
import { FingerprintsPage } from '../pages/fingerprints'
import { BookmarksPage } from '../pages/bookmarks'
import { ExtensionsPage } from '../pages/extensions'
import { ProfilesPage } from '../pages/profiles'
import {
  PreviewSidebar,
  type Section,
  type Profile,
  type ViewId,
} from '../raccoon-preview/sidebar'
import { useProfileUi } from '../entities/profile/lib/useProfileUi'
import { useViews } from '../entities/profile/lib/views'
import { ViewDialog } from '../features/manage-views'
import { ToastHost } from '../widgets/ToastHost/ToastHost'
import { ConfirmHost } from '../widgets/ConfirmHost/ConfirmHost'
import { UnsavedGuard } from '../widgets/UnsavedGuard/UnsavedGuard'
import { PageHeader, PageBody } from '../widgets/PageHeader'
import { useNav } from '../shared/model/navigation'
import { confirmLeave } from '../shared/model/unsaved'
import { toast } from '../shared/model/toast'
import { confirmModal } from '../shared/lib/confirm'
import { NativeProfileDialog } from './ProfileDialog'
import { NativeFolderDialog } from './FolderDialog'
import { NativeSettingsPage } from './Settings'
import { BitBrowserGuide } from './BitBrowserGuide'
import { TrashPage } from '../pages/trash'
import { ProxiesPage } from '../pages/proxies'
import { AssignProxiesHost } from '../features/manage-profiles/ui/AssignProxiesHost'
import { nativeFingerprintApi } from './fingerprint-api'
import { useFingerprint } from '../entities/fingerprint/lib/useFingerprint'
import { useGpuCompat } from '../shared/model/gpuCompat'
import { useWorkspace, workspace } from './store'
import { AutomationPage } from '../pages/automation'
import { PluginsPage } from '../pages/plugins'
import { captureAutomationScope } from '../entities/automation/lib/scope'
import { useAppKeys } from '../features/commands'
import { CommandPalette } from '../features/command-palette'
import { ShortcutSheet } from '../features/shortcuts'
import { NativeHelperWatcher } from './automation/connect'
import { usePluginCatalog, watchPluginCatalog } from './plugins/catalog'
import { PluginPage, RetainedAgentPage } from '../pages/plugins/PluginPage'
import { watchExtensionUpdates } from '../entities/extension'
import { shellPadClass, titleBarOnMouseDown } from '../shared/lib/dragWindow'
import { ShellWindowControls } from '../widgets/WindowControls'
import { useThemeBridge } from '../shared/model/theme'
import { PluginUiRuntime } from './plugins/PluginUiRuntime'
import {
  cancelDetailNavigation,
  failDetailNavigation,
  pendingDetailNavigation,
  watchDetailNavigation,
} from './plugins/detail-navigation'
import { startAgentDeepLinks } from './plugins/agent-deep-links'
import { findDetailProfile } from './plugins/detail-profile'

const VIEWS: Record<ViewId, string> = {
  running: 'builtin:running',
  direct: 'builtin:no-proxy',
  recent: 'builtin:recent',
}
const LABELS: Partial<Record<Section, string>> = {
  proxies: '代理',
  fingerprints: '指纹',
  extensions: '扩展',
  bookmarks: '书签',
  automation: '自动化',
  plugins: '插件中心',
  trash: '回收站',
}

export function NativeApplication() {
  useAppKeys()
  useThemeBridge()
  const plugins = usePluginCatalog((current) => current.plugins)
  const activePluginId = usePluginCatalog((current) => current.activeId)
  const navigatingDetail = useRef<number | null>(null)
  useEffect(() => watchPluginCatalog(), [])
  useEffect(() => startAgentDeepLinks(), [])
  const state = useWorkspace()
  const [section, setSection] = useState<Section>(() => {
    const initial = useNav.getState().section
    return initial === 'proxyshard' || initial === 'team' ? 'settings' : initial
  })
  const folder = useProfileUi((s) => s.folder)
  const viewId = useProfileUi((s) => s.viewId)
  const views = useViews((s) => s.views)
  const connection = state.connections.find((row) => row.id === state.connectionId)
  const shardbrowser = connection?.providerId === 'shardbrowser'
  const bitbrowser = connection?.providerId === 'bitbrowser'
  useEffect(
    () =>
      watchDetailNavigation((request) => {
        const intentId = pendingDetailNavigation()?.intentId
        if (intentId === undefined) return
        if (navigatingDetail.current === intentId) return
        const current = () => pendingDetailNavigation()?.intentId === intentId
        const pluginId =
          request.kind === 'agent'
            ? 'studio.sales-agent'
            : request.kind === 'product'
              ? 'studio.products'
              : request.kind === 'account'
                ? 'studio.vinted-accounts'
                : null
        if (pluginId && section === 'plugins' && activePluginId === pluginId) return
        if (
          pluginId &&
          !plugins.some(
            (plugin) =>
              plugin.id === pluginId && plugin.enabled && plugin.state !== 'available',
          )
        ) {
          if (usePluginCatalog.getState().loaded) {
            cancelDetailNavigation(intentId)
            toast.err('关联插件尚未安装或启用，请在插件中心检查。')
          }
          return
        }
        void (async () => {
          navigatingDetail.current = intentId
          if (!(await confirmLeave())) {
            if (current()) cancelDetailNavigation(intentId)
            return
          }
          if (!current()) return
          if (request.kind === 'window') {
            const profile = await findDetailProfile(request.id)
            if (!current()) return
            if (workspace.state.connectionId !== profile.connectionId)
              await workspace.select(profile.connectionId)
            if (!current()) return
            usePluginCatalog.setState({ activeId: null })
            setSection('profiles')
            useNav.setState({ section: 'profiles' })
            useProfileUi.getState().openPeek(profile.id)
            cancelDetailNavigation(intentId)
          } else {
            usePluginCatalog.setState({ activeId: pluginId })
            setSection('plugins')
            useNav.setState({ section: 'plugins' })
          }
        })()
          .catch((detail) =>
            failDetailNavigation(intentId, () =>
              toast.fail({ title: '无法打开关联记录', detail }),
            ),
          )
          .finally(() => {
            if (navigatingDetail.current === intentId) navigatingDetail.current = null
          })
      }),
    [plugins, section, activePluginId],
  )
  useEffect(() => {
    if (!shardbrowser || !connection?.enabled) return
    return watchExtensionUpdates()
  }, [connection?.id, connection?.enabled, shardbrowser])
  useEffect(() => {
    if (
      state.loading ||
      shardbrowser ||
      (section !== 'bookmarks' && section !== 'extensions')
    )
      return
    void useNav
      .getState()
      .setSection('profiles')
      .then((moved) => {
        if (moved) setSection('profiles')
      })
  }, [section, shardbrowser, state.loading])
  useEffect(() => {
    if (connection?.providerId !== 'shardbrowser' || !connection.enabled) return
    let active = true
    useGpuCompat.setState({ caps: null, byId: {}, loaded: false, loading: false })
    void nativeFingerprintApi
      .list()
      .then((items) => {
        if (active) useFingerprint.setState({ items, status: 'ready', error: null })
      })
      .catch((error) => {
        if (active) useFingerprint.setState({ status: 'error', error: String(error) })
      })
    return () => {
      active = false
    }
  }, [connection?.id, connection?.providerId, connection?.enabled])
  useEffect(
    () =>
      useNav.subscribe((next, previous) => {
        if (next.section !== previous.section)
          setSection(
            next.section === 'proxyshard' || next.section === 'team'
              ? 'settings'
              : next.section,
          )
      }),
    [],
  )
  const rows = useMemo<Profile[]>(
    () =>
      state.profiles.map((profile) => ({
        id: profile.id,
        providerId: profile.providerId,
        name: profile.name,
        folderId: profile.groupId,
        note: profile.settings.note,
        proxy: profile.proxyMode === 'direct' ? 'Direct' : 'Proxy',
        fingerprint: '',
        status:
          profile.state === 'running'
            ? 'running'
            : profile.state === 'stopped'
              ? 'stopped'
              : 'unknown',
        createdAt: profile.createdAt,
      })),
    [state.profiles],
  )
  useEffect(() => {
    let preferred: string | null = null
    try {
      preferred = localStorage.getItem('raccoon.v2.activeConnection')
    } catch {
      /* Use enabled ShardBrowser. */
    }
    void workspace
      .initialize(preferred)
      .catch((error) => toast.fail({ title: '工作台加载失败', detail: error }))
  }, [])
  useEffect(() => {
    if (state.loading) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const delay = section === 'profiles' ? 5000 : 15000
    const schedule = (wait = delay) => {
      clearTimeout(timer)
      if (active && !document.hidden) timer = setTimeout(poll, wait)
    }
    const poll = async () => {
      if (!active || document.hidden) return
      await workspace.refresh().catch(() => {})
      schedule()
    }
    const onVisibilityChange = () => {
      if (document.hidden) clearTimeout(timer)
      else schedule(0)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    schedule()
    return () => {
      active = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [section, state.loading])
  async function navigate(next: Section) {
    const scope = captureAutomationScope()
    if (!(await confirmLeave())) return false
    if (!scope.current()) return false
    cancelDetailNavigation()
    usePluginCatalog.setState({ activeId: null })
    setSection(next)
    useNav.setState({ section: next })
    return true
  }
  async function openPlugin(id: string) {
    if (!(await navigate('plugins'))) return
    usePluginCatalog.setState({ activeId: id })
  }
  async function select(id: string) {
    const scope = captureAutomationScope()
    if (!(await confirmLeave())) return
    if (!scope.current()) return
    cancelDetailNavigation()
    try {
      await workspace.select(id)
      if (workspace.state.connectionId !== id) return
      localStorage.setItem('raccoon.v2.activeConnection', id)
      const providerId = workspace.state.connections.find(
        (row) => row.id === id,
      )?.providerId
      const current = useNav.getState().section
      const next =
        current === 'automation' || current === 'plugins'
          ? current
          : (current === 'bookmarks' || current === 'extensions') &&
              providerId === 'shardbrowser'
            ? current
            : 'profiles'
      if (next === current) setSection(next)
      else await useNav.getState().setSection(next)
    } catch (error) {
      toast.fail({ title: 'Workspace 加载失败', detail: error })
    }
  }
  const view = (Object.keys(VIEWS) as ViewId[]).find((id) => VIEWS[id] === viewId) ?? null
  const pending = state.operations.filter(
    (row) => !['committed', 'cancelled', 'failed'].includes(row.phase),
  )
  async function endOperation(id: string) {
    if (
      !(await confirmModal({
        title: '结束待处理操作',
        message:
          '将读取实际浏览器状态并结束此次启停意图。原生服务无法确认状态时会拒绝结束。',
        confirmLabel: '核对并结束',
      }))
    )
      return
    await workspace
      .endOperation(id)
      .catch((error) => toast.fail({ title: '结束操作失败', detail: error }))
  }
  return (
    <div
      data-shell
      className={cn(
        'relative grid h-full grid-cols-[auto_minmax(0,1fr)] gap-panel overflow-hidden bg-bg-canvas',
        shellPadClass(),
      )}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) titleBarOnMouseDown(event)
      }}
    >
      <PreviewSidebar
        native
        shardLibraries={shardbrowser}
        providerId={connection?.providerId ?? 'shardbrowser'}
        connectionId={state.connectionId}
        workspaces={state.connections
          .filter((row) => row.enabled)
          .map((row) => ({ id: row.id, name: row.name, initial: row.name.slice(0, 1) }))}
        onConnection={(id) => {
          void select(id)
        }}
        onProvider={() => {}}
        section={section}
        folderId={state.folders.find((row) => row.name === folder)?.id ?? null}
        viewId={view}
        customViewId={viewId && !view ? viewId : null}
        customViews={views
          .filter((row) => row.pinned)
          .map((row) => ({ id: row.id, name: row.name }))}
        profiles={rows}
        folders={state.folders.map((row) => ({
          id: row.id,
          name: row.name,
          providerId: connection?.providerId ?? 'shardbrowser',
        }))}
        plugins={plugins.filter(
          (plugin) => plugin.enabled && plugin.state !== 'available',
        )}
        activePluginId={activePluginId}
        onPlugin={(id) => {
          void openPlugin(id)
        }}
        onSection={(next) => {
          void navigate(next)
        }}
        onFolder={(id) => {
          void navigate('profiles').then((ok) => {
            if (ok)
              useProfileUi
                .getState()
                .setFolder(state.folders.find((row) => row.id === id)?.name ?? 'all')
          })
        }}
        onView={(id) => {
          void navigate('profiles').then((ok) => {
            if (ok) useProfileUi.getState().applyView(VIEWS[id])
          })
        }}
        onCustomView={(id) => {
          void navigate('profiles').then((ok) => {
            if (ok) useProfileUi.getState().applyView(id)
          })
        }}
        onNewFolder={() => {
          if (state.connectionId)
            useProfileUi.getState().setFolderDialog({ mode: 'create' })
        }}
      />
      <main
        data-section={section}
        className="page-ground flex min-w-0 flex-col overflow-hidden rounded-panel bg-bg-page"
      >
        <RetainedAgentPage
          active={section === 'plugins' && activePluginId === 'studio.sales-agent'}
          connectionId={state.connectionId}
          onManage={() => {
            cancelDetailNavigation()
            usePluginCatalog.setState({ activeId: null })
          }}
        />
        {section === 'plugins' &&
        activePluginId === 'studio.sales-agent' ? null : section === 'automation' ? (
          state.connectionId ? (
            <AutomationPage
              key={`${state.connectionId}:${captureAutomationScope().key}`}
            />
          ) : (
            <>
              <PageHeader title="自动化" />
              <PageBody>
                <EmptyState title="请先选择已配置的浏览器 Workspace" />
              </PageBody>
            </>
          )
        ) : section === 'plugins' ? (
          activePluginId ? (
            <PluginPage
              key={`${activePluginId}:${activePluginId === 'studio.vinted-accounts' ? (state.connectionId ?? 'none') : 'global'}`}
              id={activePluginId}
              connectionId={state.connectionId}
              onManage={() => {
                cancelDetailNavigation()
                usePluginCatalog.setState({ activeId: null })
              }}
            />
          ) : (
            <PluginsPage
              onOpenPlugin={(id) => {
                void openPlugin(id)
              }}
            />
          )
        ) : section === 'settings' ? (
          <NativeSettingsPage />
        ) : section === 'trash' ? (
          <TrashPage />
        ) : section === 'proxies' ? (
          <ProxiesPage />
        ) : section === 'fingerprints' && shardbrowser ? (
          <FingerprintsPage key={connection?.id} />
        ) : section === 'extensions' && shardbrowser ? (
          <ExtensionsPage key={connection?.id} />
        ) : section === 'bookmarks' && shardbrowser ? (
          <BookmarksPage key={connection?.id} />
        ) : section === 'profiles' ? (
          <>
            {state.error && (
              <div
                role="alert"
                className="flex items-center gap-3 px-gutter py-2 text-secondary text-error-text"
              >
                <span>{state.error}</span>
                <Button
                  size="3xsmall"
                  mode="stroke"
                  variant="neutral"
                  onClick={() => {
                    void workspace.refresh().catch(() => {})
                  }}
                >
                  重新检查
                </Button>
              </div>
            )}
            {pending.length > 0 && (
              <div className="flex flex-col gap-2 px-gutter py-2 text-secondary">
                {pending.map((operation) => (
                  <div key={operation.id} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1">
                      {operation.kind} · {operation.phase} {operation.message}
                    </span>
                    <Button
                      size="3xsmall"
                      mode="stroke"
                      variant="neutral"
                      onClick={() => {
                        void workspace
                          .reconcile(operation.id)
                          .catch((error) =>
                            toast.fail({ title: '操作核对失败', detail: error }),
                          )
                      }}
                    >
                      核对结果
                    </Button>
                    {['start', 'stop'].includes(operation.kind) &&
                      ['submitted', 'uncertain'].includes(operation.phase) && (
                        <Button
                          size="3xsmall"
                          mode="stroke"
                          variant="neutral"
                          onClick={() => {
                            void endOperation(operation.id)
                          }}
                        >
                          核对并结束
                        </Button>
                      )}
                  </div>
                ))}
              </div>
            )}
            {state.connectionId ? (
              ['shardbrowser', 'cloakbrowser', 'bitbrowser'].includes(
                connection?.providerId ?? '',
              ) ? (
                <ProfilesPage />
              ) : (
                <>
                  <PageHeader title="全部配置" />
                  <PageBody>
                    <EmptyState
                      title="此浏览器接入尚未开放"
                      hint="当前工作台已接通比特浏览器、CloakBrowser 和 ShardBrowser。"
                    />
                  </PageBody>
                </>
              )
            ) : (
              <>
                <PageHeader title="全部配置" />
                <PageBody>
                  {bitbrowser && !state.loading ? (
                    <BitBrowserGuide variant="empty" />
                  ) : (
                    <EmptyState
                      title="配置浏览器接入"
                      hint="比特浏览器随应用常开；其他浏览器接入需在实验室手动开启。"
                      actions={
                        <Button
                          size="xsmall"
                          onClick={() => {
                            void useNav.getState().openSettings('laboratory')
                          }}
                        >
                          打开实验室
                        </Button>
                      }
                    />
                  )}
                </PageBody>
              </>
            )}
          </>
        ) : (
          <>
            <PageHeader title={LABELS[section] ?? 'Raccoon'} />
            <PageBody>
              <EmptyState title="此功能尚未接入当前工作台" />
            </PageBody>
          </>
        )}
      </main>
      <NativeHelperWatcher
        key={`helper:${captureAutomationScope().key}`}
        connectionId={state.connectionId}
      />
      <PluginUiRuntime />
      <ToastHost />
      <ConfirmHost />
      <UnsavedGuard />
      <NativeProfileDialog />
      <NativeFolderDialog />
      <ViewDialog />
      <AssignProxiesHost />
      <CommandPalette key={captureAutomationScope().key} />
      <ShortcutSheet />
      <ShellWindowControls />
    </div>
  )
}
