import type { DependencyList, EffectCallback } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KernelHookHarness } from '@/features/settings/kernel-test-support'
import { createScenePlan } from './api'
import { SCENE_PLAN_METHODS, type ScenePlanContext } from './scene-plan'
import { makePlan, planContext } from './scene-plan.test-data'
import { useScenePlanner } from './use-scene-planner'

const state = vi.hoisted(() => ({ hooks: null as PlannerHarness | null }))
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useLayoutEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks
        ? state.hooks.effect(effect, deps)
        : react.useLayoutEffect(effect, deps),
    useMemo: <T>(factory: () => T, deps: DependencyList) =>
      state.hooks ? state.hooks.memo(factory, deps) : react.useMemo(factory, deps),
  }
})
vi.mock('./api', () => ({ createScenePlan: vi.fn(), getScenePlan: vi.fn() }))
class PlannerHarness extends KernelHookHarness {
  memo<T>(factory: () => T, deps: DependencyList): T {
    const [cached, setCached] = this.state(undefined)
    const previous = cached as { value: T; deps: DependencyList } | undefined
    if (
      previous &&
      previous.deps.length === deps.length &&
      deps.every((value, index) => Object.is(value, previous.deps[index]))
    )
      return previous.value
    const value = factory()
    setCached({ value, deps })
    return value
  }
}
let hooks: PlannerHarness
beforeEach(() => {
  hooks = new PlannerHarness(state)
  vi.resetAllMocks()
})
afterEach(() => hooks.dispose())

it('passes the level to paid planning and blocks a stale result after the level changes', async () => {
  let context: ScenePlanContext = { ...planContext, agingLevel: 'heavy' }
  const completed = vi.fn()
  const accepted = vi.fn().mockResolvedValue(undefined)
  const render = () =>
    hooks.render(() => useScenePlanner(context, SCENE_PLAN_METHODS, completed, accepted))
  vi.mocked(createScenePlan).mockResolvedValue({ ...makePlan(), agingLevel: 'heavy' })
  render()
  hooks.flushEffects()
  await render().start(0)
  expect(createScenePlan).toHaveBeenCalledExactlyOnceWith({
    providerId: context.providerId,
    model: context.model,
    inputFileId: context.inputFileId,
    requirements: context.requirements,
    count: context.count,
    agingLevel: 'heavy',
  })
  expect(render().ready).toBe(true)
  context = { ...context, agingLevel: 'none' }
  expect(render().stale).toBe(true)
  expect(render().ready).toBe(false)
  expect(createScenePlan).toHaveBeenCalledOnce()
})
