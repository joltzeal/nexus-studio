import type {
  BrowserConnection,
  BrowserWindow,
  CreateBrowserWindowInput,
  WindowSettings,
} from '@nexus/contracts/browser'

export function browserSettings(overrides: Partial<WindowSettings> = {}): WindowSettings {
  return {
    platform: 'Vinted',
    note: '',
    geoip: true,
    timezone: '',
    locale: '',
    viewport: 'default',
    fingerprintSeed: 42,
    startUrl: '',
    ...overrides,
  }
}

export function browserWindow(overrides: Partial<BrowserWindow> = {}): BrowserWindow {
  return {
    id: 'window-1',
    name: 'window',
    providerId: 'cloakbrowser',
    connectionId: 'builtin',
    providerProfileId: 'window-1',
    origin: 'created',
    state: 'stopped',
    version: '155.0.8059.39',
    kernelVersion: '155.0.8059.39.2',
    proxy: null,
    proxyPlugin: null,
    proxyEndpoint: null,
    proxyMode: 'direct',
    settings: browserSettings(),
    groupId: null,
    createdAt: 10,
    lastOpenedAt: null,
    sortOrder: 1,
    ...overrides,
  }
}

export function browserConnection(
  overrides: Partial<BrowserConnection> = {},
): BrowserConnection {
  return {
    id: 'builtin',
    providerId: 'cloakbrowser',
    name: '内置浏览器',
    endpoint: '',
    apiKey: null,
    defaultGroupId: null,
    scopeLabel: '本机',
    scopeId: null,
    scopeConfirmed: true,
    enabled: true,
    revision: 1,
    capabilities: {
      create: true,
      update: true,
      deleteEnvironment: true,
      attach: false,
      manualProxy: true,
      proxyPlugin: true,
      geoip: true,
      fingerprintSeed: true,
      kernelSelection: true,
      transfer: true,
    },
    ...overrides,
  }
}

export function browserCreateInput(
  overrides: Partial<CreateBrowserWindowInput> = {},
): CreateBrowserWindowInput {
  return {
    operationId: '15b41684-b179-46c9-a1b8-e1b66812dc33',
    connectionId: 'builtin',
    name: 'window',
    proxyMode: 'direct',
    proxy: null,
    proxyPlugin: null,
    proxyEndpoint: null,
    settings: browserSettings(),
    groupId: null,
    kernelVersion: null,
    ...overrides,
  }
}
