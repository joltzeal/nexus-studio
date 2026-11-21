import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { useProfile, useProfileUi, reloadFolders } from '../entities/profile'
import { useViews } from '../entities/profile/lib/views'
import { useTags } from '../entities/tag'
import { ProfileFormDialog } from '../features/profile-form'
import { FolderDialog } from '../features/manage-profiles'
import { ViewDialog } from '../features/manage-views'
import { ProfilesPage } from '../pages/profiles'
import { SettingsPage } from '../pages/settings'
import { useNav } from '../shared/model/navigation'
import { ConfirmHost } from '../widgets/ConfirmHost/ConfirmHost'
import { ToastHost } from '../widgets/ToastHost/ToastHost'
import {
  PreviewSidebar,
  type Profile,
  type ProviderId,
  type Section,
  type ViewId,
} from './sidebar'
import {
  previewRunning,
  savePreviewWorkspace,
  switchPreviewWorkspace,
} from './workspaces'
import { PageBody, PageHeader } from '../widgets/PageHeader'
import { LoadingRows } from '../shared/ui/ListStates'
import { useT } from '../shared/i18n'
import { PluginsPage } from '../pages/plugins'
import { PluginPage } from '../pages/plugins/PluginPage'
import { usePluginCatalog, watchPluginCatalog } from '../raccoon/plugins/catalog'
import { UnsavedGuard } from '../widgets/UnsavedGuard/UnsavedGuard'
import { useAppKeys } from '../features/commands'
import { CommandPalette } from '../features/command-palette'
import { useThemeBridge } from '../shared/model/theme'
import '../app/wireStores'

// Lazy-loaded pages: each is its own chunk, fetched when first asked for.
const ProxiesPage = lazy(() =>
  import('../pages/proxies').then((m) => ({ default: m.ProxiesPage })),
)
const FingerprintsPage = lazy(() =>
  import('../pages/fingerprints').then((m) => ({ default: m.FingerprintsPage })),
)
const ExtensionsPage = lazy(() =>
  import('../pages/extensions').then((m) => ({ default: m.ExtensionsPage })),
)
const BookmarksPage = lazy(() =>
  import('../pages/bookmarks').then((m) => ({ default: m.BookmarksPage })),
)
const TrashPage = lazy(() =>
  import('../pages/trash').then((m) => ({ default: m.TrashPage })),
)
const AutomationPage = lazy(() =>
  import('../pages/automation').then((m) => ({ default: m.AutomationPage })),
)

/** What each lazy page shows while its code loads. */
const PAGE_TITLE: Partial<Record<Section, (t: ReturnType<typeof useT>) => string>> = {
  proxies: (t) => t('proxies.title'),
  fingerprints: (t) => t('fingerprints.title'),
  extensions: (t) => t('extensions.title'),
  bookmarks: (t) => t('bookmarks.heading'),
  automation: (t) => t('automation.title'),
  trash: (t) => t('trash.title'),
}

const VIEW: Record<ViewId, string> = {
  running: 'builtin:running',
  direct: 'builtin:no-proxy',
  recent: 'builtin:recent',
}
const FROM_VIEW = Object.fromEntries(
  Object.entries(VIEW).map(([key, value]) => [value, key]),
) as Record<string, ViewId>

/** Renders a lazy page with a loading fallback that shows its header. */
function LazyPreviewPage({ section }: { section: Section }) {
  const t = useT()
  const title = PAGE_TITLE[section]?.(t) ?? section
  let page: React.ReactNode = null
  if (section === 'proxies') page = <ProxiesPage />
  else if (section === 'fingerprints') page = <FingerprintsPage />
  else if (section === 'extensions') page = <ExtensionsPage />
  else if (section === 'bookmarks') page = <BookmarksPage />
  else if (section === 'automation') page = <AutomationPage />
  else if (section === 'trash') page = <TrashPage />
  if (!page) return null
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title={title} />
          <PageBody>
            <LoadingRows />
          </PageBody>
        </>
      }
    >
      {page}
    </Suspense>
  )
}

export function RaccoonPreview() {
  useAppKeys()
  useThemeBridge()
  const plugins = usePluginCatalog((state) => state.plugins)
  const activePluginId = usePluginCatalog((state) => state.activeId)
  useEffect(() => watchPluginCatalog(), [])
  const [providerId, setProviderId] = useState<ProviderId>('adspower')
  const [section, setSection] = useState<Section>('profiles')
  const setNavigation = useNav((state) => state.setSection)
  const profiles = useProfile((state) => state.profiles)
  const running = useProfile((state) => state.running)
  const folders = useProfile((state) => state.folderRegistry)
  const views = useViews((state) => state.views)
  const customViews = useMemo(() => views.filter((item) => item.pinned), [views])
  const folder = useProfileUi((state) => state.folder)
  const view = useProfileUi((state) => state.viewId)
  const rows = useMemo<Profile[]>(
    () =>
      profiles.map((profile) => ({
        id: profile.id,
        providerId,
        name: profile.name,
        folderId: profile.folder || null,
        note: profile.notes ?? '',
        proxy: profile.proxy_id ?? 'Direct',
        fingerprint: '',
        status: running[profile.id] ? 'running' : 'stopped',
        createdAt: profile.created_at ? Date.parse(profile.created_at) / 1000 : 0,
      })),
    [profiles, running, providerId],
  )

  useEffect(() => {
    void useProfile.getState().init()
    const stopPolling = useProfile.getState().startProcessPolling()
    const unsubscribe = useProfile.subscribe(() => savePreviewWorkspace())
    const unsubscribeViews = useViews.subscribe(() => savePreviewWorkspace())
    return () => {
      unsubscribe()
      unsubscribeViews()
      stopPolling()
    }
  }, [])

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

  async function chooseProvider(id: ProviderId) {
    if (id === providerId) return
    const ok = await setNavigation('profiles')
    if (!ok) return
    switchPreviewWorkspace(id)
    useProfileUi.getState().setFolder('all')
    useProfileUi.getState().setSearch('')
    useProfile.setState({ running: previewRunning() })
    setProviderId(id)
    setSection('profiles')
    await Promise.all([
      useProfile.getState().reload(),
      reloadFolders(),
      useTags.getState().load(),
    ])
  }

  return (
    <div
      data-shell
      className="relative grid h-full grid-cols-[auto_minmax(0,1fr)] gap-panel overflow-hidden bg-bg-canvas p-2"
    >
      <PreviewSidebar
        providerId={providerId}
        section={section}
        folderId={folder === 'all' ? null : folder}
        viewId={view ? (FROM_VIEW[view] ?? null) : null}
        customViewId={view && !FROM_VIEW[view] ? view : null}
        customViews={customViews.map((item) => ({ id: item.id, name: item.name }))}
        folders={folders.map((name) => ({ id: name, providerId, name }))}
        profiles={rows}
        plugins={plugins.filter(
          (plugin) => plugin.enabled && plugin.state !== 'available',
        )}
        activePluginId={activePluginId}
        onPlugin={(id) => {
          void setNavigation('plugins').then((ok) => {
            if (ok) {
              usePluginCatalog.setState({ activeId: id })
              setSection('plugins')
            }
          })
        }}
        onProvider={(id) => {
          void chooseProvider(id)
        }}
        onSection={(next) => {
          void setNavigation(next).then((ok) => {
            if (ok) {
              usePluginCatalog.setState({ activeId: null })
              setSection(next)
            }
          })
        }}
        onFolder={(id) => {
          void setNavigation('profiles').then((ok) => {
            if (!ok) return
            useProfileUi.getState().setFolder(id ?? 'all')
            setSection('profiles')
          })
        }}
        onView={(id) => {
          void setNavigation('profiles').then((ok) => {
            if (!ok) return
            useProfileUi.getState().applyView(VIEW[id])
            setSection('profiles')
          })
        }}
        onCustomView={(id) => {
          void setNavigation('profiles').then((ok) => {
            if (!ok) return
            useProfileUi.getState().applyView(id)
            setSection('profiles')
          })
        }}
        onNewFolder={() => useProfileUi.getState().setFolderDialog({ mode: 'create' })}
      />
      <main
        data-section={section}
        className="page-ground flex min-w-0 flex-col overflow-hidden rounded-panel bg-bg-page"
      >
        {section === 'profiles' ? (
          <ProfilesPage />
        ) : section === 'settings' ? (
          <SettingsPage />
        ) : section === 'plugins' ? (
          activePluginId ? (
            <PluginPage
              key={activePluginId}
              id={activePluginId}
              onManage={() => usePluginCatalog.setState({ activeId: null })}
            />
          ) : (
            <PluginsPage
              onOpenPlugin={(id) => usePluginCatalog.setState({ activeId: id })}
            />
          )
        ) : (
          <LazyPreviewPage section={section} />
        )}
      </main>
      <ToastHost />
      <ConfirmHost />
      <UnsavedGuard />
      <ProfileFormDialog />
      <FolderDialog />
      <ViewDialog />
      <CommandPalette />
    </div>
  )
}
