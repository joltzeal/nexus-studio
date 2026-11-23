import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  CountRoll,
  Button,
  IconButton,
  Kbd,
  NavItem,
  Tooltip,
  cn,
  useContextMenu,
} from '@proxyshard/shardx-ui-kit'
import { FoldHeading } from '../shared/ui/FoldHeading'
import { useProfileUi } from '../entities/profile/lib/useProfileUi'
import { useProfile } from '../entities/profile/lib/useProfile'
import { useFolderMeta } from '../entities/profile/lib/folderMeta'
import { labelColor } from '../shared/constants'
import type { Section as AppSection } from '../shared/types'
import { usePalette } from '../features/command-palette'
import { ariaOf, capOf, command } from '../features/commands'
import { useNav } from '../shared/model/navigation'
import { toast } from '../shared/model/toast'
import { confirmModal } from '../shared/lib/confirm'
import { PinnedGroup } from '../widgets/Sidebar/Sidebar'
import { useRailKey } from '../widgets/Sidebar/useRailKey'
import { usePluginSidebarBadge } from '../raccoon/plugins/sidebar-badge'
import { PluginNavigationIcon } from '../raccoon/plugins/PluginNavigationIcon'
import { APP_NAME, useAppVersion, useLabUnlock } from '../raccoon/app-meta'
import { formatDownloadRate, useAppUpdate } from '../raccoon/update'
import type { PluginView } from '../raccoon/plugins/types'
import {
  ClockIcon,
  FolderAddIconApp,
  FolderIcon,
  FOLDER_ICON_GLYPHS,
  GlobeIcon,
  NavAutomationIcon,
  NavBookmarksIcon,
  NavBrowsersIcon,
  NavExtensionsIcon,
  NavFingerprintsIcon,
  NavProxiesIcon,
  NavSettingsIcon,
  NavShopIcon,
  NavTrashIcon,
  PlayIcon,
  UploadIcon,
  SearchIcon,
  SidebarIcon,
  UnfoldMoreIcon,
} from '../shared/icons'

export type ProviderId =
  'adspower' | 'bitbrowser' | 'shardbrowser' | 'cloakbrowser' | 'aliasmode'
export type Section = Exclude<AppSection, 'proxyshard' | 'team'>
export type ViewId = 'running' | 'direct' | 'recent'
export type Folder = { id: string; providerId: ProviderId; name: string }
export type Profile = {
  id: string
  providerId: ProviderId
  name: string
  folderId: string | null
  note: string
  proxy: string
  fingerprint: string
  status: 'running' | 'stopped' | 'unknown'
  createdAt: number
}

export const providers: {
  id: ProviderId
  name: string
  kind: string
  initial: string
}[] = [
  { id: 'adspower', name: 'AdsPower', kind: 'Local API', initial: 'A' },
  { id: 'bitbrowser', name: '比特浏览器', kind: 'Local API', initial: 'B' },
  { id: 'shardbrowser', name: 'ShardBrowser', kind: 'Managed kernel', initial: 'S' },
  { id: 'cloakbrowser', name: 'CloakBrowser', kind: 'Managed kernel', initial: 'C' },
  { id: 'aliasmode', name: 'AliasMode', kind: 'Managed kernel', initial: 'M' },
]

type Props = {
  workspaces?: { id: string; name: string; initial: string }[]
  connectionId?: string | null
  onConnection?: (id: string) => void
  native?: boolean
  shardLibraries?: boolean
  providerId: ProviderId
  section: Section
  folderId: string | null
  viewId: ViewId | null
  customViewId: string | null
  customViews: { id: string; name: string }[]
  folders: Folder[]
  profiles: Profile[]
  plugins?: PluginView[]
  activePluginId?: string | null
  onPlugin?: (id: string) => void
  onProvider: (id: ProviderId) => void
  onSection: (section: Section) => void
  onFolder: (id: string | null) => void
  onView: (id: ViewId) => void
  onCustomView: (id: string) => void
  onNewFolder: () => void
}

function Group({
  title,
  open,
  onToggle,
  action,
  rail,
  children,
}: {
  title: string
  open: boolean
  onToggle: () => void
  action?: ReactNode
  rail: boolean
  children: ReactNode
}) {
  const labelId = useId()
  const listId = useId()
  return (
    <div className="flex flex-col gap-0.5" role="group" aria-labelledby={labelId}>
      {rail ? (
        <>
          <span id={labelId} className="sr-only">
            {title}
          </span>
          <div
            aria-hidden="true"
            className="mx-2 my-1.5 border-t border-stroke-soft-200"
          />
          {children}
        </>
      ) : (
        <>
          <div className="flex h-[24px] items-center gap-1.5 pl-2.5">
            <FoldHeading
              label={title}
              labelId={labelId}
              open={open}
              controls={listId}
              onToggle={onToggle}
            />
            <span className="min-w-0 flex-1" />
            {action}
          </div>
          {open && (
            <div id={listId} className="flex flex-col gap-0.5">
              {children}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ScrollArea({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    const list = listRef.current
    if (!el || !list) return
    const read = () => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 1)
    read()
    el.addEventListener('scroll', read, { passive: true })
    const observer = new ResizeObserver(read)
    observer.observe(el)
    observer.observe(list)
    return () => {
      el.removeEventListener('scroll', read)
      observer.disconnect()
    }
  }, [])
  return (
    <div
      ref={ref}
      data-sidebar-scroll
      data-more-below={more || undefined}
      className="-mt-[calc(var(--focus-width)*2)] min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-[calc(var(--focus-width)*2)] pb-2 [scrollbar-width:none] data-[more-below]:[mask-image:linear-gradient(to_bottom,black_calc(100%-24px),transparent)] [&::-webkit-scrollbar]:hidden"
    >
      <div ref={listRef} className="flex flex-col gap-3">
        {children}
      </div>
    </div>
  )
}

function PluginItem({
  plugin,
  rail,
  active,
  onClick,
}: {
  plugin: PluginView
  rail: boolean
  active: boolean
  onClick: () => void
}) {
  const badge = usePluginSidebarBadge(plugin)
  return (
    <NavItem
      size="small"
      label={plugin.name}
      icon={<PluginNavigationIcon plugin={plugin} className="size-3.5" />}
      collapsed={rail}
      active={active}
      badge={badge}
      onClick={onClick}
    />
  )
}

export function PreviewSidebar({
  workspaces,
  connectionId,
  onConnection,
  native = false,
  shardLibraries = false,
  providerId,
  section,
  folderId,
  viewId,
  customViewId,
  customViews,
  folders,
  profiles,
  plugins = [],
  activePluginId = null,
  onPlugin,
  onProvider,
  onSection,
  onFolder,
  onView,
  onCustomView,
  onNewFolder,
}: Props) {
  const [rail, setRail] = useState(false)
  const [pluginsOpen, setPluginsOpen] = useState(true)
  const [foldersOpen, setFoldersOpen] = useState(true)
  const [viewsOpen, setViewsOpen] = useState(true)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const folderLooks = useFolderMeta((state) => state.byName)
  const folderMenu = useContextMenu()
  const updatePhase = useAppUpdate((state) => state.phase)
  const updateVersion = useAppUpdate((state) => state.version)
  const updateProgress = useAppUpdate((state) => state.progress)
  const updateSpeed = useAppUpdate((state) => state.speedBytesPerSecond)
  const installUpdate = useAppUpdate((state) => state.install)
  const tapVersion = useLabUnlock((state) => state.tap)
  const version = useAppVersion((state) => state.version)
  const upgrade = async () => {
    if (updatePhase !== 'ready') return
    const confirmed = await confirmModal({
      title: '重启并完成更新',
      message: `Raccoon ${updateVersion ?? ''} 已下载完成，重启应用后自动安装。`,
      confirmLabel: '立即重启',
    })
    if (!confirmed) return
    await installUpdate().catch((error) =>
      toast.fail({ title: '安装更新失败', detail: error }),
    )
  }
  useRailKey(() => setRail((value) => !value))
  const current = native
    ? (workspaces?.find((item) => item.id === connectionId) ?? {
        name: '配置浏览器接入',
        initial: 'R',
      })
    : providers.find((item) => item.id === providerId)!
  const item = (id: Section, label: string, icon: ReactNode, badge?: ReactNode) => (
    <NavItem
      key={id}
      size="small"
      icon={icon}
      label={label}
      collapsed={rail}
      active={section === id}
      badge={badge}
      onClick={() => onSection(id)}
    />
  )
  const count = (value: number) => (
    <span className="flex" data-count>
      <CountRoll value={value} />
    </span>
  )
  const currentFolder =
    section === 'profiles' && !viewId && !customViewId ? folderId : null
  const showShardLibraries = native ? shardLibraries : providerId !== 'cloakbrowser'
  const views: { id: ViewId; name: string; icon: ReactNode; count: number }[] = [
    {
      id: 'running',
      name: '运行中',
      icon: <PlayIcon className="size-3.5" />,
      count: profiles.filter((profile) => profile.status === 'running').length,
    },
    {
      id: 'direct',
      name: '无代理',
      icon: <GlobeIcon className="size-3.5" />,
      count: profiles.filter((profile) => profile.proxy === 'Direct').length,
    },
    {
      id: 'recent',
      name: '最近使用',
      icon: <ClockIcon className="size-3.5" />,
      count: Math.min(profiles.length, 10),
    },
  ]

  return (
    <aside
      data-region="sidebar"
      data-rail={rail || undefined}
      className={cn(
        'white-surface flex min-h-0 flex-col rounded-panel bg-bg-white-0',
        rail ? 'w-[56px]' : 'w-[232px]',
      )}
    >
      <div
        className={cn(
          'flex h-[52px] shrink-0 items-center',
          rail ? 'justify-center' : 'pl-4 pr-2',
        )}
      >
        {!rail && (
          <span
            data-brand
            className="flex items-center gap-2 text-ui font-bold text-text-strong-950"
          >
            <img src="/raccoon.png" alt="" className="size-6 rounded-[5px]" />
            <span>Raccoon</span>
          </span>
        )}
        <IconButton
          size="3xsmall"
          className={cn(!rail && 'ml-auto')}
          label={rail ? '展开侧边栏' : '收起侧边栏'}
          icon={<SidebarIcon className="size-3.5" />}
          onClick={() => setRail(!rail)}
        />
      </div>
      <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col">
        <ScrollArea>
          <div data-sidebar-fixed className="flex flex-col gap-0.5">
            <NavItem
              size="small"
              data-nav="search"
              data-tour="search"
              icon={<SearchIcon className="size-3.5" />}
              label="搜索"
              collapsed={rail}
              shortcut={capOf(command('app.palette'))}
              aria-keyshortcuts={ariaOf(command('app.palette'))}
              onClick={() => usePalette.getState().setOpen(true)}
              badge={<Kbd aria-hidden="true">{capOf(command('app.palette'))}</Kbd>}
            />
            <NavItem
              size="small"
              icon={<NavBrowsersIcon className="size-3.5" />}
              label="全部配置"
              collapsed={rail}
              active={
                section === 'profiles' && folderId === null && !viewId && !customViewId
              }
              badge={count(profiles.length)}
              onClick={() => onFolder(null)}
            />
            {item('proxies', '代理', <NavProxiesIcon className="size-3.5" />)}
            {providerId === 'shardbrowser' &&
              item('fingerprints', '指纹', <NavFingerprintsIcon className="size-3.5" />)}
            {showShardLibraries &&
              item('extensions', '扩展', <NavExtensionsIcon className="size-3.5" />)}
            {showShardLibraries &&
              item('bookmarks', '书签', <NavBookmarksIcon className="size-3.5" />)}
            {item('automation', '自动化', <NavAutomationIcon className="size-3.5" />)}
            <NavItem
              size="small"
              icon={<NavShopIcon className="size-3.5" />}
              label="插件中心"
              collapsed={rail}
              active={section === 'plugins' && !activePluginId}
              onClick={() => onSection('plugins')}
            />
          </div>
          {plugins.length > 0 && (
            <Group
              title="插件"
              open={pluginsOpen}
              onToggle={() => setPluginsOpen(!pluginsOpen)}
              rail={rail}
            >
              {plugins.map((plugin) => (
                <PluginItem
                  key={plugin.id}
                  plugin={plugin}
                  rail={rail}
                  active={section === 'plugins' && activePluginId === plugin.id}
                  onClick={() => onPlugin?.(plugin.id)}
                />
              ))}
            </Group>
          )}
          {native && <PinnedGroup compact={rail} />}
          <div data-tour="views-folders" className="flex flex-col gap-3">
            <Group
              title="文件夹"
              open={foldersOpen}
              onToggle={() => setFoldersOpen(!foldersOpen)}
              rail={rail}
              action={
                <IconButton
                  label="新建文件夹"
                  size="3xsmall"
                  icon={<FolderAddIconApp className="size-3.5" />}
                  onClick={onNewFolder}
                />
              }
            >
              {folders.map((folder) => {
                const look = folderLooks[folder.name]
                const Glyph =
                  native && look
                    ? (FOLDER_ICON_GLYPHS[look.icon] ?? FolderIcon)
                    : FolderIcon
                return (
                  <NavItem
                    key={folder.id}
                    size="small"
                    icon={
                      <Glyph
                        className="size-3.5"
                        style={
                          native && look?.color
                            ? { color: labelColor(look.color) }
                            : undefined
                        }
                      />
                    }
                    label={folder.name}
                    collapsed={rail}
                    active={currentFolder === folder.id}
                    badge={count(
                      profiles.filter((profile) => profile.folderId === folder.id).length,
                    )}
                    onClick={() => onFolder(folder.id)}
                    onContextMenu={
                      native
                        ? (event) =>
                            folderMenu.open(
                              event,
                              [
                                {
                                  label: '编辑 Folder',
                                  onSelect: () =>
                                    useProfileUi.getState().setFolderDialog({
                                      mode: 'edit',
                                      name: folder.name,
                                    }),
                                },
                                {
                                  label: '删除 Folder',
                                  danger: true,
                                  onSelect: () => {
                                    void useProfile.getState().deleteFolder(folder.name)
                                  },
                                },
                              ],
                              { heading: folder.name },
                            )
                        : undefined
                    }
                  />
                )
              })}
              {rail && (
                <NavItem
                  size="small"
                  icon={<FolderAddIconApp className="size-3.5" />}
                  label="新建文件夹"
                  collapsed
                  onClick={onNewFolder}
                />
              )}
            </Group>
            <Group
              title="视图"
              open={viewsOpen}
              onToggle={() => setViewsOpen(!viewsOpen)}
              rail={rail}
            >
              {views.map((view) => (
                <NavItem
                  key={view.id}
                  size="small"
                  icon={view.icon}
                  label={view.name}
                  collapsed={rail}
                  active={section === 'profiles' && viewId === view.id}
                  badge={count(view.count)}
                  onClick={() => onView(view.id)}
                />
              ))}
              {customViews.map((view) => (
                <NavItem
                  key={view.id}
                  size="small"
                  icon={<NavBookmarksIcon className="size-3.5" />}
                  label={view.name}
                  collapsed={rail}
                  active={section === 'profiles' && customViewId === view.id}
                  onClick={() => onCustomView(view.id)}
                />
              ))}
            </Group>
          </div>
        </ScrollArea>
      </nav>
      <div data-sidebar-footer className="flex shrink-0 flex-col gap-0.5 p-2">
        <div className="relative">
          <NavItem
            size="small"
            icon={<span className="text-[11px] font-semibold">{current.initial}</span>}
            label={current.name}
            collapsed={rail}
            badge={<UnfoldMoreIcon className="size-3.5 text-icon-soft-400" />}
            aria-haspopup="menu"
            aria-expanded={workspaceOpen}
            onClick={() => setWorkspaceOpen(!workspaceOpen)}
          />
          {workspaceOpen && (
            <div
              role="menu"
              aria-label="切换 Workspace"
              className={cn(
                'absolute bottom-full z-30 mb-1 w-[232px] rounded-panel border border-stroke-soft-200 bg-bg-white-0 p-1 shadow-(--shadow-float)',
                rail ? 'left-[48px]' : 'left-0',
              )}
            >
              {native
                ? workspaces?.map((entry) => (
                    <NavItem
                      size="small"
                      role="menuitemradio"
                      aria-checked={entry.id === connectionId}
                      key={entry.id}
                      onClick={() => {
                        onConnection?.(entry.id)
                        setWorkspaceOpen(false)
                      }}
                      icon={
                        <span className="text-[11px] font-semibold">{entry.initial}</span>
                      }
                      label={entry.name}
                      active={entry.id === connectionId}
                    />
                  ))
                : providers.map((provider) => (
                    <NavItem
                      size="small"
                      role="menuitemradio"
                      aria-checked={provider.id === providerId}
                      key={provider.id}
                      onClick={() => {
                        onProvider(provider.id)
                        setWorkspaceOpen(false)
                      }}
                      icon={
                        <span className="text-[11px] font-semibold">
                          {provider.initial}
                        </span>
                      }
                      label={provider.name}
                      active={provider.id === providerId}
                    />
                  ))}
              {native && (
                <NavItem
                  size="small"
                  role="menuitem"
                  label="浏览器接入设置"
                  icon={<NavSettingsIcon className="size-3.5" />}
                  onClick={() => {
                    onSection('settings')
                    setWorkspaceOpen(false)
                  }}
                />
              )}
            </div>
          )}
        </div>
        {item('trash', '回收站', <NavTrashIcon className="size-3.5" />)}
        {item('settings', '设置', <NavSettingsIcon className="size-3.5" />)}
        {!rail && (
          <>
            <div
              aria-hidden="true"
              className="mx-2 my-1.5 border-t border-stroke-soft-200"
            />
            {updatePhase === 'checking' || updatePhase === 'downloading' ? (
              <div className="flex h-9 min-w-0 items-center justify-center">
                <span
                  role="status"
                  aria-label={
                    updatePhase === 'checking'
                      ? '正在检查应用更新'
                      : `正在下载 Raccoon ${updateVersion ?? ''}，${updateProgress === null ? '进度未知' : `${Math.round(updateProgress * 100)}%`}，${formatDownloadRate(updateSpeed)}`
                  }
                  className="flex h-8 max-w-full items-center gap-1.5 rounded-full border border-primary-base/20 bg-primary-tint px-2.5 text-ui text-primary-text"
                >
                  <UploadIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate whitespace-nowrap">
                    {updatePhase === 'checking'
                      ? '正在检查更新'
                      : `正在下载… ${updateProgress === null ? '' : `${Math.round(updateProgress * 100)}% · `}${formatDownloadRate(updateSpeed)}`}
                  </span>
                </span>
              </div>
            ) : (
              <div className="flex h-8 min-w-0 items-center justify-between gap-1.5 px-2 text-secondary text-text-sub-600">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="size-[7px] shrink-0 rounded-full bg-success-base" />
                  <span className="truncate">{APP_NAME}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <Tooltip content="连续点击 6 次打开实验室" side="top">
                    <span
                      className="tabular-nums text-text-soft-400"
                      data-version
                      onClick={() => {
                        if (tapVersion())
                          void useNav.getState().openSettings('laboratory')
                      }}
                    >
                      {`v${version}`}
                    </span>
                  </Tooltip>
                  {(updatePhase === 'ready' || updatePhase === 'installing') && (
                    <Button
                      size="3xsmall"
                      mode="lighter"
                      variant="neutral"
                      aria-label={`Raccoon ${updateVersion ?? ''} 已下载，点击安装更新`}
                      className="rounded-full border border-primary-base/20 !bg-primary-tint !text-ui !text-primary-text"
                      isLoading={updatePhase === 'installing'}
                      onClick={() => void upgrade()}
                    >
                      {updatePhase === 'installing'
                        ? '正在安装…'
                        : `安装 v${updateVersion ?? '更新'}`}
                    </Button>
                  )}
                </span>
              </div>
            )}
          </>
        )}
      </div>
      {folderMenu.node}
    </aside>
  )
}
