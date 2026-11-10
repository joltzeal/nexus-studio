import {
  BrowserConnectionProbeSchema,
  BrowserConnectionSchema,
  BrowserWindowSchema,
  ProviderGroupSchema,
  RemoteProfileSchema,
  SaveBrowserConnectionInputSchema,
  type BrowserProviderId,
  type SaveBrowserConnectionInput,
} from '@nexus/contracts/browser'
import { readBrowser } from './browser-api'
import { orderBrowserWindows } from './windows'

export type {
  BrowserCapabilities,
  BrowserConnection,
  BrowserConnectionProbe,
  BrowserProviderId,
  ProviderGroup,
  RemoteProfile,
  SaveBrowserConnectionInput,
} from '@nexus/contracts/browser'

export const BROWSER_PROVIDERS: { id: BrowserProviderId; name: string }[] = [
  { id: 'cloakbrowser', name: '内置浏览器' },
  { id: 'adspower', name: 'AdsPower' },
  { id: 'bitbrowser', name: '比特浏览器' },
]

export function listBrowserConnections() {
  return readBrowser(BrowserConnectionSchema.array(), 'browser_connection_list')
}

export function saveBrowserConnection(input: SaveBrowserConnectionInput) {
  return readBrowser(BrowserConnectionSchema, 'browser_connection_save', {
    input: SaveBrowserConnectionInputSchema.parse(input),
  })
}

export function probeBrowserConnection(id: string) {
  return readBrowser(BrowserConnectionProbeSchema, 'browser_connection_probe', { id })
}

export function confirmBrowserConnection(id: string, scopeLabel: string) {
  return readBrowser(BrowserConnectionSchema, 'browser_connection_confirm', {
    id,
    scopeLabel,
  })
}

export function activateBrowserConnection(id: string) {
  return readBrowser(BrowserConnectionSchema, 'browser_connection_activate', { id })
}

export function discoverBrowserProfiles(connectionId: string) {
  return readBrowser(RemoteProfileSchema.array(), 'browser_profile_discover', {
    connectionId,
  })
}

export function listBrowserProviderGroups(connectionId: string) {
  return readBrowser(ProviderGroupSchema.array(), 'browser_group_list', {
    connectionId,
  })
}

export async function attachBrowserWindows(connectionId: string, profileIds: string[]) {
  if (profileIds.length === 0 || new Set(profileIds).size !== profileIds.length) {
    throw new Error('请选择不重复的浏览器环境。')
  }
  return orderBrowserWindows(
    await readBrowser(BrowserWindowSchema.array(), 'browser_window_attach', {
      connectionId,
      profileIds,
    }),
  )
}
