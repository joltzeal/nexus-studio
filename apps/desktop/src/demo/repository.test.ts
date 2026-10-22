import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WINDOW_CONFIG,
  DEMO_INITIAL_STATE,
  PLUGIN_CATALOG,
  parseDemoState,
  parseWindowConfig,
} from './model'
import type { DemoState } from './model'
import { createDemoRepository, DEMO_STORAGE_KEY, getDemoRepository } from './repository'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    }),
  }
}

function populated(): DemoState {
  return {
    schemaVersion: 2,
    groups: [{ id: 'group', name: '日常', tone: 'blue' }],
    spaces: [
      {
        id: 'window',
        name: 'Vinted',
        platform: 'Vinted',
        groupId: 'group',
        note: '',
        tone: 'blue',
        config: structuredClone(DEFAULT_WINDOW_CONFIG),
      },
    ],
    enabledPlugins: [],
  }
}

describe('local window persistence', () => {
  it('starts empty and does not write sample records', () => {
    const storage = memoryStorage()
    expect(createDemoRepository(storage).load()).toEqual(DEMO_INITIAL_STATE)
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('creates, updates, reads and deletes a window while preserving its configuration', () => {
    const storage = memoryStorage()
    const repository = createDemoRepository(storage)
    const next = populated()
    next.spaces[0]!.config = {
      proxy: { protocol: 'socks5', server: 'socks5://localhost:1080' },
      geoip: true,
      timezone: 'America/New_York',
      locale: 'en-US',
      viewport: '1920x1080',
      fingerprintSeed: 12345,
      startUrl: 'https://www.vinted.com',
    }
    expect(repository.save(next)).toEqual(next)
    expect(repository.load().spaces[0]?.config).toEqual(next.spaces[0]?.config)
    next.spaces[0]!.name = '美国站'
    repository.save(next)
    expect(repository.load().spaces[0]?.name).toBe('美国站')
    next.spaces = []
    repository.save(next)
    expect(repository.load().spaces).toEqual([])
  })

  it('loads legacy v1 records without changing stored bytes until a successful save', () => {
    const storage = memoryStorage()
    const legacy = populated()
    const raw = JSON.stringify({
      ...legacy,
      schemaVersion: 1,
      spaces: legacy.spaces.map((space) => ({
        id: space.id,
        name: space.name,
        platform: space.platform,
        groupId: space.groupId,
        note: space.note,
        tone: space.tone,
      })),
    })
    storage.values.set(DEMO_STORAGE_KEY, raw)
    const repository = createDemoRepository(storage)
    const migrated = repository.load()
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.spaces[0]?.config).toEqual(DEFAULT_WINDOW_CONFIG)
    expect(storage.values.get(DEMO_STORAGE_KEY)).toBe(raw)
    repository.save(migrated)
    expect(JSON.parse(storage.values.get(DEMO_STORAGE_KEY)!).schemaVersion).toBe(2)
  })

  it('removes old sample labels and canned notes when reading prior records', () => {
    const state = populated()
    state.groups[0]!.name = '示例 · 日常'
    state.spaces[0]!.name = '演示 · 周末小店'
    state.spaces[0]!.note = '仅用于界面演示，不连接平台或真实账号。'
    const parsed = parseDemoState(state)
    expect(parsed.groups[0]?.name).toBe('日常')
    expect(parsed.spaces[0]?.name).toBe('周末小店')
    expect(parsed.spaces[0]?.note).toBe('')
  })

  it.each([
    { proxy: { protocol: 'http', server: 'http://user:secret@host:8080' } },
    { proxy: { protocol: 'socks5', server: 'socks5://host' } },
    { proxy: { protocol: 'http', server: 'http://host:0' } },
    { proxy: { protocol: 'direct', server: '' }, geoip: true },
    { timezone: 'Invalid/Region' },
    { locale: 'invalid_locale' },
    { fingerprintSeed: 0 },
    { startUrl: 'file:///private/data' },
    { startUrl: 'https://user:secret@example.com' },
  ])('rejects invalid configuration without writing: %j', (override) => {
    const storage = memoryStorage()
    const repository = createDemoRepository(storage)
    repository.save(populated())
    const original = storage.values.get(DEMO_STORAGE_KEY)
    const next = populated()
    next.spaces[0]!.config = {
      ...next.spaces[0]!.config,
      ...override,
    } as typeof DEFAULT_WINDOW_CONFIG
    expect(() => repository.save(next)).toThrow('本地数据无效')
    expect(storage.values.get(DEMO_STORAGE_KEY)).toBe(original)
  })

  it('rejects extra configuration keys and dangling group references', () => {
    const next = populated()
    const invalid = {
      ...next,
      spaces: [
        { ...next.spaces[0], config: { ...DEFAULT_WINDOW_CONFIG, password: 'secret' } },
      ],
    }
    expect(() => parseDemoState(invalid)).toThrow('未知字段')
    next.groups = []
    expect(() => parseDemoState(next)).toThrow('不存在的分组')
  })

  it('accepts optional settings and preserves a detached copy', () => {
    const parsed = parseWindowConfig(DEFAULT_WINDOW_CONFIG)
    expect(parsed).toEqual(DEFAULT_WINDOW_CONFIG)
    const storage = memoryStorage()
    const state = populated()
    const saved = createDemoRepository(storage).save(state)
    state.spaces[0]!.name = 'changed outside repository'
    expect(saved.spaces[0]?.name).toBe('Vinted')
  })

  it('keeps invalid stored content intact on read and attempted write', () => {
    const storage = memoryStorage()
    storage.values.set(DEMO_STORAGE_KEY, '{"schemaVersion":999}')
    const repository = createDemoRepository(storage)
    expect(() => repository.load()).toThrow('原始内容已保留')
    expect(() => repository.save(populated())).toThrow('原始内容已保留')
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('keeps the prior record after storage write failure', () => {
    const storage = memoryStorage()
    const repository = createDemoRepository(storage)
    repository.save(populated())
    const original = storage.values.get(DEMO_STORAGE_KEY)
    storage.setItem.mockImplementationOnce(() => {
      throw new Error('quota')
    })
    expect(() => repository.save(DEMO_INITIAL_STATE)).toThrow('未能保存')
    expect(storage.values.get(DEMO_STORAGE_KEY)).toBe(original)
  })

  it('persists plugin selections without executing a plugin', () => {
    const storage = memoryStorage()
    const state = populated()
    state.enabledPlugins = [PLUGIN_CATALOG[0].id]
    createDemoRepository(storage).save(state)
    expect(createDemoRepository(storage).load().enabledPlugins).toEqual([
      PLUGIN_CATALOG[0].id,
    ])
  })

  it('reports inaccessible storage and retries when available', () => {
    const storage = memoryStorage()
    let denied = true
    vi.stubGlobal('window', {
      get localStorage() {
        if (denied) throw new Error('security')
        return storage
      },
    })
    try {
      expect(() => getDemoRepository()).toThrow('无法访问本地存储')
      denied = false
      expect(getDemoRepository().load()).toEqual(DEMO_INITIAL_STATE)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
