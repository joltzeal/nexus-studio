import { describe, expect, it } from 'vitest'
import {
  BrowserConnectionSchema,
  BrowserErrorSchema,
  BrowserWindowSchema,
  CreateBrowserWindowInputSchema,
  MoveBrowserWindowsGroupInputSchema,
  RemoteProfileSchema,
  ResolveBrowserOperationInputSchema,
  UpdateBrowserWindowInputSchema,
} from './browser.js'

const settings = {
  platform: 'Vinted',
  note: '',
  geoip: false,
  timezone: '',
  locale: '',
  viewport: 'default',
  fingerprintSeed: null,
  startUrl: '',
}
const window = {
  id: 'window-1',
  name: 'attached',
  providerId: 'adspower',
  connectionId: 'ads-1',
  providerProfileId: 'remote-1',
  origin: 'attached',
  state: 'unknown',
  version: '',
  kernelVersion: null,
  proxy: null,
  proxyPlugin: null,
  proxyEndpoint: null,
  proxyMode: 'provider',
  settings,
  groupId: null,
  createdAt: 1,
  lastOpenedAt: null,
  sortOrder: 2,
}
const input = {
  operationId: '15b41684-b179-46c9-a1b8-e1b66812dc33',
  connectionId: 'ads-1',
  name: 'new',
  proxyMode: 'provider',
  proxy: null,
  proxyPlugin: null,
  proxyEndpoint: null,
  settings,
  groupId: null,
  kernelVersion: null,
}

describe('browser boundary contracts', () => {
  it('requires a scoped, nonempty and unique batch of window UUIDs for moving groups', () => {
    const move = {
      connectionId: 'ads-1',
      ids: [input.operationId],
      groupId: 'ddaa515f-1af3-4a5b-9405-73a18f54ac8d',
    }
    expect(MoveBrowserWindowsGroupInputSchema).toBeDefined()
    expect(MoveBrowserWindowsGroupInputSchema.parse(move)).toEqual(move)
    expect(
      MoveBrowserWindowsGroupInputSchema.parse({ ...move, groupId: null }).groupId,
    ).toBeNull()
    for (const invalid of [
      { ...move, connectionId: '' },
      { ...move, ids: [] },
      { ...move, ids: [input.operationId, input.operationId] },
      { ...move, ids: ['vendor-profile'] },
      { ...move, groupId: 'ungrouped' },
      { ...move, groupId: undefined },
      { ...move, settings },
    ]) {
      expect(MoveBrowserWindowsGroupInputSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('accepts only explicitly confirmed association and abandonment resolutions', () => {
    expect(ResolveBrowserOperationInputSchema).toBeDefined()
    const associate = {
      id: input.operationId,
      action: 'associate',
      providerProfileId: 'official-1',
      confirmed: true,
    }
    const abandon = { id: input.operationId, action: 'abandon', confirmed: true }
    expect(ResolveBrowserOperationInputSchema.parse(associate)).toEqual(associate)
    expect(ResolveBrowserOperationInputSchema.parse(abandon)).toEqual(abandon)
    for (const invalid of [
      { ...associate, id: 'name-seed' },
      { ...associate, providerProfileId: '' },
      { ...associate, providerProfileId: undefined },
      { ...associate, confirmed: false },
      { ...associate, confirmed: undefined },
      { ...associate, windowId: 'other' },
      { ...associate, operationId: input.operationId },
      { ...abandon, providerProfileId: 'official-1' },
      { ...abandon, confirmed: 'true' },
      { ...abandon, action: 'retry' },
      { action: 'abandon', confirmed: true },
    ]) {
      expect(ResolveBrowserOperationInputSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('accepts explicit unknown state, unknown version and provider-owned proxy', () => {
    expect(BrowserWindowSchema.parse(window)).toEqual(window)
  })

  it('rejects legacy, missing and extra window fields without defaults', () => {
    for (const key of Object.keys(window)) {
      const missing = { ...window } as Record<string, unknown>
      delete missing[key]
      expect(BrowserWindowSchema.safeParse(missing).success, key).toBe(false)
    }
    for (const value of [
      { ...window, running: false },
      { ...window, state: 'ready' },
      { ...window, settings: { ...settings, extra: true } },
      { ...window, sortOrder: 1.5 },
    ]) {
      expect(BrowserWindowSchema.safeParse(value).success).toBe(false)
    }
  })

  it('requires an operation UUID for creation and forbids rebinding on edit', () => {
    expect(CreateBrowserWindowInputSchema.parse(input)).toEqual(input)
    expect(
      CreateBrowserWindowInputSchema.safeParse({ ...input, operationId: 'name-seed' })
        .success,
    ).toBe(false)
    const { operationId, connectionId, kernelVersion, ...fields } = input
    expect(operationId).toBe('15b41684-b179-46c9-a1b8-e1b66812dc33')
    expect(connectionId).toBe('ads-1')
    expect(kernelVersion).toBeNull()
    const edit = { id: 'window-1', ...fields }
    expect(UpdateBrowserWindowInputSchema.parse(edit)).toEqual(edit)
    expect(
      UpdateBrowserWindowInputSchema.safeParse({ ...edit, connectionId: 'other' })
        .success,
    ).toBe(false)
    expect(
      UpdateBrowserWindowInputSchema.safeParse({ ...edit, kernelVersion: null }).success,
    ).toBe(false)
  })

  it('requires complete connection capabilities and nullable fields', () => {
    const capabilities = {
      create: true,
      update: false,
      deleteEnvironment: true,
      attach: true,
      manualProxy: true,
      proxyPlugin: true,
      geoip: true,
      fingerprintSeed: false,
      kernelSelection: false,
      transfer: false,
    }
    const connection = {
      id: 'ads-1',
      providerId: 'adspower',
      name: 'AdsPower',
      endpoint: 'http://localhost:50325',
      apiKey: null,
      defaultGroupId: null,
      scopeLabel: 'workspace',
      scopeId: null,
      scopeConfirmed: false,
      enabled: false,
      revision: 1,
      capabilities,
    }
    expect(BrowserConnectionSchema.parse(connection)).toEqual(connection)
    expect(
      BrowserConnectionSchema.safeParse({
        ...connection,
        capabilities: { ...capabilities, extra: true },
      }).success,
    ).toBe(false)
    expect(
      BrowserConnectionSchema.safeParse({ ...connection, apiKey: undefined }).success,
    ).toBe(false)
  })

  it('preserves opaque remote provider snapshots but rejects a non-object config', () => {
    const remote = {
      id: 'official-1',
      name: 'existing',
      kernelVersion: null,
      createdAt: null,
      providerConfig: { fingerprint: { vendorField: true } },
    }
    expect(RemoteProfileSchema.parse(remote)).toEqual(remote)
    expect(RemoteProfileSchema.safeParse({ ...remote, providerConfig: [] }).success).toBe(
      false,
    )
  })

  it('validates structured desktop errors', () => {
    expect(
      BrowserErrorSchema.parse({
        code: 'operation_uncertain',
        message: 'Check the operation before retrying',
        retryable: false,
      }),
    ).toEqual({
      code: 'operation_uncertain',
      message: 'Check the operation before retrying',
      retryable: false,
    })
    expect(
      BrowserErrorSchema.safeParse({ code: 'unavailable', message: 'offline' }).success,
    ).toBe(false)
  })
})
