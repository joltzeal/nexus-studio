import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  createNativeProfile,
  listNativeProfiles,
  orderProfilesNewestFirst,
  updateNativeProfileNote,
  type NativeProfile,
  type WindowSettings,
} from './native-profiles'
import type { KernelSelection } from './native-kernels'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}))

const settings: WindowSettings = {
  platform: 'Vinted',
  note: '',
  geoip: true,
  timezone: '',
  locale: '',
  viewport: 'default',
  fingerprintSeed: 123,
  startUrl: '',
}

beforeEach(() => vi.resetAllMocks())

function profile(id: string, createdAt: number): NativeProfile {
  return {
    id,
    name: id,
    createdAt,
    version: '145.0.7632.109.2',
    proxy: null,
    proxyPlugin: null,
    proxyEndpoint: null,
    running: false,
    groupId: null,
    settings: { ...settings },
    lastOpenedAt: null,
  }
}

describe('window creation order', () => {
  it('shows newest windows first regardless of UUID, name or last-opened time', async () => {
    const records = [
      { ...profile('a-old', 10), lastOpenedAt: 500, running: true },
      profile('b-legacy', 0),
      profile('z-new', 30),
      profile('c-middle', 20),
    ]
    vi.mocked(invoke).mockResolvedValueOnce(records)
    expect((await listNativeProfiles()).map((entry) => entry.id)).toEqual([
      'z-new',
      'c-middle',
      'a-old',
      'b-legacy',
    ])
    expect(records.map((entry) => entry.id)).toEqual([
      'a-old',
      'b-legacy',
      'z-new',
      'c-middle',
    ])
  })

  it('preserves the host insertion order for equal creation seconds', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      profile('z-newest-in-second', 20),
      profile('a-earlier-in-second', 20),
      profile('old', 10),
    ])
    expect((await listNativeProfiles()).map((entry) => entry.id)).toEqual([
      'z-newest-in-second',
      'a-earlier-in-second',
      'old',
    ])
  })

  it('keeps a newly created same-second window above the existing rows', () => {
    const existing = [profile('existing', 30), profile('older', 10)]
    const created = profile('created', 30)
    expect(
      orderProfilesNewestFirst([created, ...existing]).map((entry) => entry.id),
    ).toEqual(['created', 'existing', 'older'])
  })
})

describe('inline window notes', () => {
  it('sends only the note patch and confirms the stored value', async () => {
    vi.mocked(invoke).mockImplementation(async (command, payload) => {
      expect(command).toBe('profile_update_note')
      expect(payload).toEqual({ id: 'window-1', note: 'new note' })
      return 'new note'
    })
    expect(await updateNativeProfileNote('window-1', '  new note  ')).toBe('new note')
  })

  it('allows clearing and a 120-character Unicode note', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('')
    expect(await updateNativeProfileNote('window-1', '   ')).toBe('')
    const note = '窗'.repeat(120)
    vi.mocked(invoke).mockResolvedValueOnce(note)
    expect(await updateNativeProfileNote('window-1', note)).toBe(note)
  })

  it('rejects too-long notes before sending a native request', async () => {
    await expect(updateNativeProfileNote('window-1', 'a'.repeat(121))).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not report a successful save when storage fails or the result is malformed', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(updateNativeProfileNote('window-1', 'keep draft')).rejects.toThrow(
      'storage unavailable',
    )
    for (const result of [undefined, 'stale note', { note: 'keep draft' }]) {
      vi.mocked(invoke).mockResolvedValueOnce(result)
      await expect(updateNativeProfileNote('window-1', 'keep draft')).rejects.toThrow()
    }
  })
})

describe('window kernel selection contract', () => {
  it('explicitly defaults new windows to the base kernel', async () => {
    await createNativeProfile('Window', null, null, null, settings)

    expect(invoke).toHaveBeenCalledExactlyOnceWith('profile_create', {
      name: 'Window',
      proxy: null,
      proxyPlugin: null,
      proxyEndpoint: null,
      settings,
      kernelKind: 'base',
      browserVersion: null,
      groupId: null,
    })
  })

  it.each<KernelSelection>([
    { kind: 'base', version: '145.0.7632.109.2' },
    { kind: 'latest' },
    { kind: 'latest', version: '155.0.8059.39.1' },
  ])(
    'forwards the chosen kernel without changing proxy or group binding: %j',
    async (kernel) => {
      await createNativeProfile(
        'Window',
        null,
        'studio.proxy-pool',
        7,
        settings,
        kernel,
        'group-1',
      )

      expect(invoke).toHaveBeenCalledExactlyOnceWith('profile_create', {
        name: 'Window',
        proxy: null,
        proxyPlugin: 'studio.proxy-pool',
        proxyEndpoint: 7,
        settings,
        kernelKind: kernel.kind,
        browserVersion: kernel.version ?? null,
        groupId: 'group-1',
      })
    },
  )
})
