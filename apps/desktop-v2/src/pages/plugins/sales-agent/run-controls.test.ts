import type { DependencyList, EffectCallback } from 'react'
import type { AgentBatchView } from '@nexus/plugin-sdk/agent'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { Button } from './controls'
import { components, flushPromises, KernelHookHarness, text } from './test-support'
import { controlAgentBatch } from './api'
import { RunControls } from './run-controls'

const context = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      context.hooks ? context.hooks.state(initial) : react.useState(initial),
    useRef: (initial: unknown) =>
      context.hooks
        ? context.hooks.state(() => ({ current: initial }))[0]
        : react.useRef(initial),
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      context.hooks ? context.hooks.effect(effect, deps) : react.useEffect(effect, deps),
  }
})
vi.mock('./api', () => ({
  controlAgentBatch: vi.fn(),
  controlAgentJob: vi.fn(),
  agentError: () => '请求失败',
}))
vi.mock('./state', () => ({
  controlReason: () => null,
  jobControlReason: () => null,
}))

let hooks: KernelHookHarness
let changed = vi.fn<() => void>()
const render = () =>
  hooks.render(() =>
    RunControls({ batch: { id: 'batch-1' } as AgentBatchView, onChanged: changed }),
  )
function click(label: string) {
  const target = components(render(), Button).find(
    (button) => text(button.props.children) === label,
  )
  expect(target).toBeDefined()
  target!.props.onClick?.({} as never)
}

beforeEach(() => {
  vi.resetAllMocks()
  hooks = new KernelHookHarness(context)
  changed = vi.fn()
})
afterEach(() => hooks.dispose())

describe('retained agent run controls', () => {
  it('settles a hidden mutation once on return and then permits a new explicit action', async () => {
    const batch = { id: 'batch-1' } as AgentBatchView
    let resolve!: (value: AgentBatchView) => void
    vi.mocked(controlAgentBatch)
      .mockReturnValueOnce(
        new Promise<AgentBatchView>((done) => {
          resolve = done
        }),
      )
      .mockResolvedValueOnce(batch)
    render()
    hooks.flushEffects()
    click('暂停')
    hooks.suspend()
    resolve(batch)
    await flushPromises()
    expect(changed).not.toHaveBeenCalled()
    expect(controlAgentBatch).toHaveBeenCalledTimes(1)
    render()
    hooks.flushEffects()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(text(render())).toContain('操作已确认')
    click('继续执行')
    await flushPromises()
    expect(controlAgentBatch).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenCalledTimes(2)
  })
})

vi.mock('./scope', async () => {
  const react = await import('react')
  const { RequestScope } = await import('./state')
  return {
    useAgentConnection: () => 'local',
    useAgentRequestScope: () => {
      const [scope] = react.useState(() => new RequestScope())
      react.useEffect(() => () => scope.invalidate(), [scope])
      return scope
    },
  }
})
