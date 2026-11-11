import {
  activateBrowserConnection,
  confirmBrowserConnection,
  saveBrowserConnection,
  type BrowserConnection,
  type BrowserProviderId,
  type SaveBrowserConnectionInput,
} from './browser-connections'

export function browserConnectionDefaults(
  providerId: Exclude<BrowserProviderId, 'cloakbrowser'>,
): SaveBrowserConnectionInput {
  const name = providerId === 'adspower' ? 'AdsPower' : '比特浏览器'
  return {
    providerId,
    name,
    endpoint:
      providerId === 'adspower' ? 'http://127.0.0.1:50325' : 'http://127.0.0.1:54345',
    apiKey: null,
    defaultGroupId: null,
    scopeLabel: name,
  }
}

export async function connectBrowser(
  input: SaveBrowserConnectionInput,
  onSaved: (saved: BrowserConnection) => void,
  previous?: BrowserConnection | null,
): Promise<BrowserConnection> {
  const unchanged =
    previous &&
    input.id === previous.id &&
    input.providerId === previous.providerId &&
    input.name.trim() === previous.name &&
    input.endpoint.trim().replace(/\/+$/, '') === previous.endpoint &&
    (input.apiKey?.trim() || null) === previous.apiKey &&
    input.defaultGroupId === previous.defaultGroupId &&
    input.scopeLabel.trim() === previous.scopeLabel
  const saved = unchanged ? previous : await saveBrowserConnection(input)
  onSaved(saved)
  // Confirmation performs a fresh native API probe before accepting the connection.
  const confirmed = await confirmBrowserConnection(
    saved.id,
    saved.scopeLabel || saved.name,
  )
  return confirmed.enabled ? confirmed : activateBrowserConnection(saved.id)
}
