import type { MouseEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button, DialogModal } from '@proxyshard/shardx-ui-kit'
import {
  ComponentHooks,
  components,
  flushPromises,
} from '../../../raccoon/plugins/component.test-support'
import type { PluginView } from '../../../raccoon/plugins/types'
import type { RecordList, SmsRecord } from '../../../raccoon/plugins/sim8/types'
import { Sim8NumberPicker } from './Sim8NumberPicker'

const state = vi.hoisted(() => ({
  hooks: null as ComponentHooks | null,
  native: true,
  plugins: [] as PluginView[],
  records: vi.fn(),
  accounts: vi.fn(),
}))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) =>
      state.hooks ? state.hooks.effect(callback, deps) : react.useEffect(callback, deps),
  }
})
vi.mock('@proxyshard/shardx-ui-kit', () => ({
  Alert: () => null,
  Badge: () => null,
  Button: () => null,
  DialogModal: () => null,
  Input: () => null,
}))
vi.mock('../../../raccoon/plugins/catalog', () => ({
  usePluginCatalog: (select: (value: { plugins: PluginView[] }) => unknown) =>
    select({ plugins: state.plugins }),
}))
vi.mock('../../../raccoon/plugins/ui-session', () => ({
  pluginUiIdentity: (plugin: PluginView) =>
    `${plugin.installation}:${plugin.runtimeGeneration}`,
}))
vi.mock('../../../raccoon/runtime', () => ({
  isNativeRaccoon: () => state.native,
}))
vi.mock('../../../raccoon/plugins/sim8/api', () => ({
  sim8Api: { records: () => state.records() },
}))
vi.mock('../../../raccoon/plugins/sim8/accounts', () => ({
  createNativeSim8AccountBridge: () => ({ list: () => state.accounts() }),
}))

const record = (tel: string, api = 'https://sms.example/?token=secret'): SmsRecord => ({
  tel,
  token: 'secret',
  api,
  apiId: 1,
  ordernum: 'ORDER',
  appId: 1,
  cateId: 1,
  type: 1,
  endTime: '2099-01-01T00:00:00Z',
  remark: '',
  status: 1,
  renew: 0,
  smsCount: 0,
  voiceCount: 0,
  addedAt: '2026-11-19T00:00:00Z',
  updatedAt: '2026-11-19T00:00:00Z',
  lastRead: null,
})
const result = (items: SmsRecord[]): RecordList => ({
  items,
  total: items.length,
  matched: items.length,
  storageDurable: true,
})
let props: Parameters<typeof Sim8NumberPicker>[0]
const render = () => state.hooks!.render(() => Sim8NumberPicker(props))
const tree = () => {
  render()
  state.hooks!.flush()
  return render()
}
const clickEvent = {} as MouseEvent<HTMLButtonElement>
const open = () => components(tree(), Button)[0]!.props.onClick?.(clickEvent)
const choices = (node = tree()) =>
  components(node, Button).filter((button) => button.props['aria-label'])

beforeEach(() => {
  state.hooks = new ComponentHooks()
  state.native = true
  state.plugins = [
    {
      id: 'studio.sim8',
      name: 'SIM8',
      version: '1.0.0',
      apiVersion: 1,
      minCoreVersion: '0.2.0',
      capabilities: ['verification.provider'],
      granted: ['verification.provider'],
      permissions: {
        networkDomains: [],
        wantsBrowserAccess: false,
        storage: 'private',
        secrets: [],
      },
      source: 'local',
      state: 'running',
      enabled: true,
      methods: ['sim8.records.list'],
      status: null,
      lastError: null,
      storageDurable: true,
      secretSlots: [],
      sourceDirectory: null,
      installation: 'installed',
      runtimeGeneration: 'first',
    },
  ]
  state.records.mockReset().mockResolvedValue(result([record('+14155550100')]))
  state.accounts.mockReset().mockResolvedValue([])
  props = { disabled: false, onPick: vi.fn() }
})
afterEach(() => {
  state.hooks?.dispose()
  state.hooks = null
})

describe('SIM8 account number selection', () => {
  it('keeps available numbers selectable when account occupancy cannot be loaded', async () => {
    state.accounts.mockRejectedValue(new Error('private service details'))
    state.records.mockResolvedValue(
      result([record('+14155550100'), record('+14155550101', '')]),
    )
    open()
    tree()
    await flushPromises()
    const buttons = choices()
    expect(JSON.stringify(tree())).toContain('账号占用未知')
    expect(buttons[0]?.props.disabled).toBe(false)
    expect(buttons[1]?.props.disabled).toBe(true)
    buttons[0]?.props.onClick?.(clickEvent)
    expect(props.onPick).toHaveBeenCalledExactlyOnceWith(
      {
        tel: '+14155550100',
        api: 'https://sms.example/?token=secret',
      },
      'installed:first',
    )
  })

  it('blocks a previous plugin instance before its replacement effect runs', async () => {
    open()
    tree()
    await flushPromises()
    expect(choices()).toHaveLength(1)
    state.plugins = [{ ...state.plugins[0]!, runtimeGeneration: 'second' }]
    for (const button of choices(render())) button.props.onClick?.(clickEvent)
    expect(props.onPick).not.toHaveBeenCalled()
  })

  it('discards a pending number response after the plugin instance changes', async () => {
    let resolveOld: (value: RecordList) => void = () => {}
    state.records
      .mockImplementationOnce(
        () =>
          new Promise<RecordList>((resolve) => {
            resolveOld = resolve
          }),
      )
      .mockResolvedValue(result([record('+14155550199')]))
    open()
    tree()
    state.plugins = [{ ...state.plugins[0]!, runtimeGeneration: 'second' }]
    tree()
    await flushPromises()
    resolveOld(result([record('+14155550100')]))
    await flushPromises()
    const buttons = choices()
    expect(buttons.map((button) => button.props['aria-label'])).toEqual([
      '选择号码 +14155550199',
    ])
    props.disabled = true
    const dialog = components(tree(), DialogModal)[0]!
    dialog.props.onCancel?.()
    expect(components(tree(), DialogModal)).toHaveLength(1)
    expect(choices().every((button) => button.props.disabled)).toBe(true)
  })
})
