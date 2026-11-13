import type { DependencyList, EffectCallback, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toast'
import {
  components,
  deferred,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { saveAgentSettings, testAgentModel } from './api'
import { AgentSettingsForm } from './settings-dialog'
import { ExecutionSettings } from './execution-settings'
import { settings } from './test-data'

const state = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : react.useEffect(effect, deps),
  }
})
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  saveAgentSettings: vi.fn(),
  testAgentModel: vi.fn(),
}))
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn() } }))

describe('model settings persistence and credential boundaries', () => {
  let hooks: KernelHookHarness
  const onSaved = vi.fn()
  const render = (): ReactNode =>
    hooks.render(() => AgentSettingsForm({ initial: settings, onSaved }))
  const button = (label: string) =>
    components(render(), Button).find((node) => text(node.props.children) === label)!
  const click = (label: string) =>
    button(label).props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
  const edit = (id: string, value: string) =>
    components(render(), Input)
      .find((node) => node.props.id === id)!
      .props.onChange?.({ target: { value } } as React.ChangeEvent<HTMLInputElement>)
  beforeEach(() => {
    vi.clearAllMocks()
    hooks = new KernelHookHarness(state)
    render()
    hooks.flushEffects()
  })
  afterEach(() => hooks.dispose())

  it('requires saving changed settings before testing and calls the chosen model kind', async () => {
    edit('agent-generation-model', 'updated-vision')
    expect(button('测试生成 / 识图模型').props.disabled).toBe(true)
    vi.mocked(saveAgentSettings).mockResolvedValue({
      ...settings,
      generation: { ...settings.generation, model: 'updated-vision' },
    })
    click('保存模型配置')
    await flushPromises()
    expect(saveAgentSettings).toHaveBeenCalledExactlyOnceWith({
      ...settings,
      generation: { ...settings.generation, model: 'updated-vision' },
    })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(button('测试生成 / 识图模型').props.disabled).toBe(false)
    vi.mocked(testAgentModel).mockResolvedValue({
      ok: true,
      kind: 'generation',
      model: 'updated-vision',
      checks: { vision: true, english: true },
    })
    click('测试生成 / 识图模型')
    await flushPromises()
    expect(testAgentModel).toHaveBeenCalledExactlyOnceWith('generation')
    expect(text(render())).toContain('图片识别：通过')
    expect(text(render())).toContain('英文文案：通过')
  })

  it('retains a password input after failed save and does not echo a credential in UI or logs', async () => {
    const log = vi.spyOn(console, 'log')
    const warn = vi.spyOn(console, 'warn')
    const error = vi.spyOn(console, 'error')
    const fixture = 'fixture-new-key-for-test'
    edit('agent-generation-key', fixture)
    vi.mocked(saveAgentSettings).mockRejectedValue(
      new Error(`Provider refused key ${fixture}`),
    )
    click('保存模型配置')
    await flushPromises()
    const input = components(render(), Input).find(
      (node) => node.props.id === 'agent-generation-key',
    )!
    expect(input.props).toMatchObject({ type: 'password', value: fixture })
    expect(text(render())).toContain('保存未确认')
    expect(text(render())).not.toContain(fixture)
    expect(onSaved).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('hides an old passing result after editing and clears it before a failed retest', async () => {
    vi.mocked(testAgentModel)
      .mockResolvedValueOnce({
        ok: true,
        kind: 'decision',
        model: settings.decision.model,
        checks: { judgement: true },
      })
      .mockRejectedValueOnce(new Error('Controlled test failure'))
    click('测试判断模型')
    await flushPromises()
    expect(text(render())).toContain('结构化判断：通过')
    click('测试判断模型')
    await flushPromises()
    expect(text(render())).toContain('模型测试失败')
    expect(text(render())).not.toContain('结构化判断：通过')
    vi.mocked(testAgentModel).mockResolvedValueOnce({
      ok: true,
      kind: 'decision',
      model: settings.decision.model,
      checks: { judgement: true },
    })
    click('测试判断模型')
    await flushPromises()
    edit('agent-decision-model', 'another-model')
    expect(text(render())).not.toContain('结构化判断：通过')
    expect(button('测试判断模型').props.disabled).toBe(true)
  })

  it('explains the missing prices when a fee budget fails before saving', async () => {
    components(render(), ExecutionSettings)[0]!.props.onChange({
      ...settings,
      execution: { ...settings.execution, maxBatchCostUsd: 2 },
    })
    click('保存模型配置')
    await flushPromises()
    expect(saveAgentSettings).not.toHaveBeenCalled()
    expect(text(render())).toContain('设置费用预算前，请完整填写两个模型的价格')
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('ignores a save completion after replacing or closing the settings session', async () => {
    const pending = deferred<typeof settings>()
    edit('agent-generation-model', 'updated-vision')
    vi.mocked(saveAgentSettings).mockReturnValue(pending.promise)
    click('保存模型配置')
    hooks.dispose()
    pending.resolve(settings)
    await flushPromises()
    expect(onSaved).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
