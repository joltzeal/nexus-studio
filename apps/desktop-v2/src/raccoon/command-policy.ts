import type { Command, Subject } from '../shared/commands/types'
import { isNativeRaccoon } from './runtime'
import { workspace, openNativeEditor } from './store'
import { toast } from '../shared/model/toast'
import { nativeProfileCdp, nativeProfileFocus } from './profile-cookies-api'
import { clip } from '../shared/lib/clipboard'
import { useAutomation } from '../entities/automation/lib/useAutomation'
import { captureAutomationScope } from '../entities/automation/lib/scope'

const SUPPORTED = new Set([
  'profile.start',
  'profile.stop',
  'profile.cancelStart',
  'profile.openPeek',
  'profile.showInList',
  'profile.edit',
  'profile.rename',
  'profile.moveToFolder',
  'profile.removeFromFolder',
  'profile.copyId',
  'profile.trash',
  'profile.select',
  'profile.selectAll',
  'profile.closePeek',
  'profile.clearSelection',
  'profile.moveThrough',
  'profile.firstLast',
  'profile.selectRange',
  'profile.addToSelection',
  'profile.new',
  'profile.editView',
  'app.newFolder',
  'folder.open',
  'folder.edit',
  'folder.delete',
  'app.filter',
  'proxy.openPeek',
  'proxy.test',
  'proxy.copyAddress',
  'proxy.assign',
  'proxy.export',
  'proxy.delete',
  'proxy.select',
  'proxy.selectAll',
  'proxy.closePeek',
  'proxy.clearSelection',
  'proxy.moveThrough',
  'proxy.firstLast',
  'proxy.new',
  'proxy.import',
  'profile.proxy',
  'profile.tags',
  'profile.clone',
  'profile.pin',
  'profile.unpin',
  'trash.restore',
  'trash.deleteForGood',
  'trash.empty',
  'profile.copyCdp',
  'profile.showWindow',
  'profile.exportCookies',
  'profile.importCookies',
  'profile.export',
  'profile.import',
  'profile.regenerate',
  'profile.fold.continue',
  'profile.unfold.continue',
  'profile.fold.needs',
  'profile.unfold.needs',
  'bookmark.new',
  'bookmark.import',
  'nav.extensions',
  'nav.bookmarks',
  'nav.automation',
  'automation.save',
  'app.tidyCanvas',
  'app.palette',
  'app.shortcuts',
  'app.stopAll',
  'app.theme',
  'app.themeLight',
  'app.themeDark',
  'app.themeSystem',
  'app.toggleSidebar',
  'nav.profiles',
  'nav.proxies',
  'nav.fingerprints',
  'nav.trash',
  'nav.settings',
  'settings.general',
  'settings.appearance',
  'settings.other',
])

/** Palette rows that have no Raccoon integration and stay out of the search. */
const HIDDEN = new Set([
  'app.whatsNew',
  'app.tour',
  'app.website',
  'nav.proxyshard',
  'nav.team',
  'team.create',
  'team.join',
  'team.addMember',
  'sync.now',
  'profile.launchSynced',
])

/** The Settings tabs whose content Raccoon actually provides. */
const SETTINGS_TABS = new Set([
  'settings.general',
  'settings.appearance',
  'settings.other',
])

export function nativeCommandVisible(command: Command): boolean {
  if (!isNativeRaccoon()) return true
  if (HIDDEN.has(command.id)) return false
  if (command.id.startsWith('settings.') && !SETTINGS_TABS.has(command.id)) return false
  const provider = workspace.state.connections.find(
    (row) => row.id === workspace.state.connectionId,
  )?.providerId
  if (
    command.id === 'nav.bookmarks' ||
    command.id === 'nav.extensions' ||
    command.id === 'nav.fingerprints' ||
    command.area === 'bookmarks'
  )
    return provider === 'shardbrowser'
  if (command.id === 'profile.import')
    return provider === 'shardbrowser' && workspace.createBlockReason() === null
  return true
}

export function nativeCommandReason(command: Command, subject: Subject): string | null {
  if (!isNativeRaccoon()) return null
  if (!SUPPORTED.has(command.id)) return '此功能尚未接入 Raccoon'
  if (
    (command.id === 'nav.bookmarks' || command.id === 'nav.extensions') &&
    workspace.state.connections.find((row) => row.id === workspace.state.connectionId)
      ?.providerId !== 'shardbrowser'
  ) {
    return '此功能仅在 ShardBrowser Workspace 可用'
  }
  const provider = workspace.state.connections.find(
    (row) => row.id === workspace.state.connectionId,
  )?.providerId
  if (
    (provider === 'cloakbrowser' || provider === 'bitbrowser') &&
    [
      'profile.copyCdp',
      'profile.showWindow',
      'profile.pin',
      'profile.unpin',
      'profile.exportCookies',
      'profile.importCookies',
      'profile.export',
      'profile.import',
      'profile.regenerate',
    ].includes(command.id)
  ) {
    return `${provider === 'bitbrowser' ? '比特浏览器' : 'CloakBrowser'} 暂未接入此操作`
  }
  if (
    ['nav.automation', 'automation.save', 'app.tidyCanvas'].includes(command.id) &&
    !workspace.state.connectionId
  )
    return '请先选择已配置的浏览器 Workspace'
  if (command.id === 'profile.new') return workspace.createBlockReason()
  if (command.id === 'app.newFolder' && !workspace.state.connectionId)
    return '请先启用浏览器接入'
  if (
    command.id === 'proxy.assign' &&
    (!workspace.state.connectionId || workspace.state.profiles.length === 0)
  )
    return '请先选择包含 Profile 的 Workspace'
  const profiles = workspace.state.profiles.filter((row) => subject.ids.includes(row.id))
  if (profiles.some((row) => workspace.state.busy.has(row.id)))
    return 'Profile 操作正在进行'
  if (
    [
      'profile.edit',
      'profile.rename',
      'profile.trash',
      'profile.proxy',
      'profile.clone',
      'profile.importCookies',
      'profile.regenerate',
    ].includes(command.id) &&
    profiles.some((row) => row.state !== 'stopped')
  )
    return '请先确认 Profile 已停止'
  return null
}

export function runNativeCommand(command: Command, subject: Subject): boolean {
  if (!isNativeRaccoon()) return false
  if (command.id === 'app.tidyCanvas') {
    const scope = captureAutomationScope()
    const id = useAutomation.getState().openId
    if (id)
      void useAutomation
        .getState()
        .tidy(id)
        .then(() => {
          if (scope.current())
            toast.undo('画布已整理', () => {
              if (scope.current() && useAutomation.getState().openId === id)
                void useAutomation.getState().undo()
            })
        })
    return true
  }
  if (command.id === 'profile.copyCdp') {
    void nativeProfileCdp(subject.ids[0])
      .then((info) => clip.write(info.web_socket_debugger_url))
      .then(
        () => toast.ok('调试地址已复制'),
        (error) => toast.fail({ title: '读取调试地址失败', detail: error }),
      )
    return true
  }
  if (command.id === 'profile.showWindow') {
    void nativeProfileFocus(subject.ids[0]).catch((error) =>
      toast.fail({ title: '显示浏览器失败', detail: error }),
    )
    return true
  }
  if (command.id === 'profile.copyId') {
    void clip.write(subject.ids[0]).then(
      () => toast.ok('Profile ID 已复制'),
      (error) => toast.fail({ title: '复制失败', detail: error }),
    )
    return true
  }
  if (command.id === 'profile.new') {
    openNativeEditor(null)
    return true
  }
  if (command.id === 'profile.edit' || command.id === 'profile.rename') {
    openNativeEditor(subject.ids[0])
    return true
  }
  return false
}
