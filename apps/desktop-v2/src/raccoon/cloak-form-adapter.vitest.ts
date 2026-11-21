import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserConnection, BrowserWindow } from '@nexus/contracts/browser'
import { useProfile } from '../entities/profile'
import { useProxy } from '../entities/proxy'
import {
  closeProfileForm,
  useProfileForm,
} from '../features/profile-form/model/useProfileForm'
import { loadNativeProfileForm, openNativeProfileForm } from './profile-form-adapter'
import { saveCloakProfileForm } from './cloak-form-adapter'
import { workspace } from './store'
import { poolProxyChoice } from './profile-proxy'
import { nativeTagApi } from './tag-api'

vi.hoisted(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { search: '' } }))
})

const connectionId = 'builtin-cloakbrowser'
const initialWorkspace = workspace.state
const initialProfile = useProfile.getState()
const initialProxy = useProxy.getState()
const connection: BrowserConnection = {
  id: connectionId,
  providerId: 'cloakbrowser',
  name: 'CloakBrowser',
  endpoint: '',
  apiKey: null,
  defaultGroupId: null,
  scopeLabel: '',
  scopeId: connectionId,
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
    transfer: false,
  },
}
const profile: BrowserWindow = {
  id: 'cloak-profile',
  name: 'Cloak profile',
  providerId: 'cloakbrowser',
  connectionId,
  providerProfileId: 'cloak-profile',
  origin: 'created',
  state: 'stopped',
  version: '156.0.8078.47.1',
  kernelVersion: '156.0.8078.47.1',
  proxy: null,
  proxyPlugin: null,
  proxyEndpoint: null,
  proxyMode: 'direct',
  groupId: null,
  createdAt: 1,
  lastOpenedAt: null,
  sortOrder: 0,
  settings: {
    platform: '其他',
    note: '',
    geoip: false,
    timezone: '',
    locale: '',
    viewport: 'default',
    fingerprintSeed: 42069,
    aliasEngine: null,
    operatingSystem: 'host',
    cpuCores: null,
    startUrl: '',
  },
}

beforeEach(() => {
  workspace.state = {
    ...initialWorkspace,
    connections: [connection],
    connectionId,
    profiles: [profile],
  }
  useProfile.setState({ fingerprints: [] })
  useProxy.setState({ proxies: [], reload: async () => {} })
})

afterEach(() => {
  closeProfileForm()
  workspace.state = initialWorkspace
  useProfile.setState(initialProfile)
  useProxy.setState(initialProxy)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

it('opens a CloakBrowser creation draft without consulting the fingerprint library', async () => {
  vi.spyOn(workspace, 'loadKernels').mockResolvedValue(undefined)
  const errors: string[] = []
  const unsubscribe = useProfileForm.subscribe(({ error }) => {
    if (error) errors.push(error)
  })
  try {
    await openNativeProfileForm({ mode: 'create' })
    expect(useProfileForm.getState()).toMatchObject({
      provider: 'cloakbrowser',
      status: 'idle',
      draft: { cloak: { kernel: '__latest' } },
    })
    expect(errors).toEqual([])
  } finally {
    unsubscribe()
  }
})

it('edits the saved CloakBrowser record without reaching ShardBrowser or refreshing kernels', async () => {
  const loadForm = vi.fn(loadNativeProfileForm)
  useProfile.setState({ loadForm })
  const loadKernels = vi
    .spyOn(workspace, 'loadKernels')
    .mockRejectedValue(new Error('内核列表不可用'))

  await openNativeProfileForm({ mode: 'edit', id: profile.id })
  expect(useProfileForm.getState()).toMatchObject({
    status: 'idle',
    error: null,
    draft: { form: { id: profile.id }, cloak: { kernel: profile.kernelVersion } },
  })
  expect(loadForm).not.toHaveBeenCalled()
  expect(loadKernels).not.toHaveBeenCalled()
})

it('reopens the stored plugin proxy as its concrete picker selection', async () => {
  const bound: BrowserWindow = {
    ...profile,
    proxyMode: 'plugin',
    proxyPlugin: 'studio.proxy-pool',
    proxyEndpoint: 42,
  }
  workspace.state = { ...workspace.state, profiles: [bound] }
  await openNativeProfileForm({ mode: 'edit', id: profile.id })
  expect(useProfileForm.getState().draft?.form.proxy_id).toBe(poolProxyChoice(42))
})

it('saves the selected endpoint through the native Profile update contract', async () => {
  await openNativeProfileForm({ mode: 'edit', id: profile.id })
  const draft = useProfileForm.getState().draft!
  useProfileForm.setState({
    draft: { ...draft, form: { ...draft.form, proxy_id: poolProxyChoice(42) } },
  })
  vi.spyOn(nativeTagApi, 'list').mockResolvedValue({ tags: [], by_profile: {} })
  const update = vi.spyOn(workspace, 'update').mockResolvedValue(undefined)
  expect(await saveCloakProfileForm()).toBe(true)
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      id: profile.id,
      proxyMode: 'plugin',
      proxyId: null,
      proxy: null,
      proxyPlugin: 'studio.proxy-pool',
      proxyEndpoint: 42,
    }),
  )
})
