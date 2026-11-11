import { expect, it, vi } from 'vitest'
import { DEFAULT_PREFERENCES } from '@nexus/contracts'
import {
  ConfigurationArchiveSchema,
  exportConfiguration,
  importConfiguration,
  pluginConfigurationTargets,
  type ConfigurationArchive,
  type ConfigurationTarget,
} from './configuration'
import { callPlugin, type PluginView } from './native-plugins'

vi.mock('./native-plugins', () => ({ callPlugin: vi.fn() }))

const target = (
  id: string,
  patch: Partial<ConfigurationTarget> = {},
): ConfigurationTarget => ({
  id,
  name: id,
  version: '1.0.0',
  available: true,
  read: vi.fn().mockResolvedValue({ schemaVersion: 1, data: { key: 'fixture-key' } }),
  validate: vi.fn().mockResolvedValue(undefined),
  write: vi.fn().mockResolvedValue(undefined),
  ...patch,
})
const archive = (
  plugins: ConfigurationArchive['plugins'] = [],
): ConfigurationArchive => ({
  format: 'nexus-configuration',
  schemaVersion: 1,
  exportedAt: '2026-11-11T00:00:00.000Z',
  preferences: { ...DEFAULT_PREFERENCES },
  networkProxy: { mode: 'direct', url: null },
  plugins,
})
const pluginEntry = (id: string) => ({
  id,
  name: id,
  version: '1.0.0',
  configuration: { schemaVersion: 1 as const, data: { key: 'fixture-key' } },
})

it('rejects unknown file versions, duplicate plugins, and invalid top-level settings', () => {
  for (const value of [
    { ...archive(), schemaVersion: 2 },
    archive([pluginEntry('studio.ai-image'), pluginEntry('studio.ai-image')]),
    { ...archive(), preferences: { theme: 'invalid' } },
    { ...archive(), networkProxy: { mode: 'manual', url: 'invalid' } },
  ])
    expect(ConfigurationArchiveSchema.safeParse(value).success).toBe(false)
})

it('exports selected supported settings and reports unavailable plugins instead of silently losing them', async () => {
  const good = target('studio.ai-image')
  const offline = target('studio.sim8', { available: false })
  const result = await exportConfiguration([good, offline], {
    preferences: { ...DEFAULT_PREFERENCES },
    networkProxy: null,
  })
  expect(result.archive.plugins).toEqual([pluginEntry(good.id)])
  expect(result.skipped).toEqual([offline.name])
  expect(offline.read).not.toHaveBeenCalled()
})

it('validates every selected plugin before any setting is changed', async () => {
  const first = target('studio.ai-image')
  const second = target('studio.sim8', {
    validate: vi.fn().mockRejectedValue(new Error('invalid token settings')),
  })
  const preferences = vi.fn()
  await expect(
    importConfiguration({
      archive: archive([pluginEntry(first.id), pluginEntry(second.id)]),
      targets: [first, second],
      selected: [first.id, second.id, 'preferences'],
      writePreferences: preferences,
      writeNetworkProxy: vi.fn(),
    }),
  ).rejects.toThrow('invalid token settings')
  expect(preferences).not.toHaveBeenCalled()
  expect(first.write).not.toHaveBeenCalled()
  expect(second.write).not.toHaveBeenCalled()
})

it('reports each actual write result, preserves unselected settings and puts network changes last', async () => {
  const order: string[] = []
  const first = target('studio.ai-image', {
    write: vi.fn(async () => {
      order.push('plugin')
      throw new Error('disk full')
    }),
  })
  const preferences = vi.fn(async () => {
    order.push('preferences')
  })
  const network = vi.fn(async () => {
    order.push('network')
  })
  const result = await importConfiguration({
    archive: archive([pluginEntry(first.id)]),
    targets: [first],
    selected: [first.id, 'networkProxy'],
    writePreferences: preferences,
    writeNetworkProxy: network,
  })
  expect(result).toEqual([
    { id: first.id, name: first.name, success: false, error: 'disk full' },
    { id: 'networkProxy', name: '应用代理', success: true },
  ])
  expect(order).toEqual(['plugin', 'network'])
  expect(preferences).not.toHaveBeenCalled()
})

it('refuses to claim success for a selected plugin that is not installed', async () => {
  await expect(
    importConfiguration({
      archive: archive([pluginEntry('studio.sim8')]),
      targets: [],
      selected: ['studio.sim8'],
      writePreferences: vi.fn(),
      writeNetworkProxy: vi.fn(),
    }),
  ).rejects.toThrow('未安装或暂不可用')
})

it('requires explicit plugin confirmation for validation and persisted writes', async () => {
  const [plugin] = pluginConfigurationTargets([
    {
      id: 'studio.ai-image',
      name: 'AI',
      version: '1.0.0',
      enabled: true,
      state: 'running',
      capabilities: ['image.provider'],
      granted: ['image.provider'],
      methods: ['configuration.export', 'configuration.validate', 'configuration.import'],
    } as PluginView,
  ])
  vi.mocked(callPlugin).mockResolvedValueOnce({ valid: false })
  await expect(
    plugin!.validate(pluginEntry('studio.ai-image').configuration),
  ).rejects.toThrow('未确认配置校验通过')
  vi.mocked(callPlugin).mockResolvedValueOnce({ imported: false })
  await expect(
    plugin!.write(pluginEntry('studio.ai-image').configuration),
  ).rejects.toThrow('未确认配置写入成功')
})
