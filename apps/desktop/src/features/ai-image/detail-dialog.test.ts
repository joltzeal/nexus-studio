import type {
  ComponentProps,
  EffectCallback,
  DependencyList,
  MouseEvent,
  ReactNode,
} from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import {
  components,
  deferred,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { toast } from '@/components/ui/toast'
import { getRecord, recognizeRecord } from './api'
import { RecordDetailDialog } from './detail-dialog'
import { makeProvider, makeSceneRecord } from './scene-plan.test-data'
import type { GenerationRecord } from './types'

const state = vi.hoisted(() => ({ hooks: null as KernelHookHarness | null }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) =>
      state.hooks ? state.hooks.state(initial) : react.useState(initial),
    useRef: (initial: unknown) =>
      state.hooks
        ? state.hooks.state(() => ({ current: initial }))[0]
        : react.useRef(initial),
    useLayoutEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks
        ? state.hooks.effect(effect, deps)
        : react.useLayoutEffect(effect, deps),
  }
})
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  getRecord: vi.fn(),
  recognizeRecord: vi.fn(),
}))
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn() } }))

let hooks: KernelHookHarness | undefined
afterEach(() => {
  hooks?.dispose()
  vi.resetAllMocks()
})

describe('accepted output recognition', () => {
  it('refreshes remembered models after closing a pending request without reviving the dialog', async () => {
    hooks = new KernelHookHarness(state)
    const record = makeSceneRecord()
    delete record.scenePlan
    const pending = deferred<{ record: GenerationRecord }>()
    vi.mocked(getRecord).mockResolvedValue({ record })
    vi.mocked(recognizeRecord).mockReturnValue(pending.promise)
    const props: ComponentProps<typeof RecordDetailDialog> = {
      recordId: record.id,
      providers: [makeProvider()],
      selections: {
        image: null,
        vision: { providerId: 'vision-provider', model: 'vision-model' },
      },
      modelConfigReady: true,
      onClose: vi.fn(),
      onChanged: vi.fn().mockResolvedValue(undefined),
    }
    const wrapper = RecordDetailDialog(props)
    const Content = wrapper.type as (props: typeof wrapper.props) => ReactNode
    const render = () => hooks!.render(() => Content(wrapper.props))
    const click = (label: string) => {
      const button = components(render(), Button).find(
        (node) => text(node.props.children) === label,
      )!
      button.props.onClick?.({} as MouseEvent<HTMLButtonElement>)
    }
    render()
    hooks.flushEffects()
    await flushPromises()
    click('识别当前成片')
    expect(recognizeRecord).toHaveBeenCalledExactlyOnceWith({
      id: record.id,
      providerId: 'vision-provider',
      model: 'vision-model',
      fileId: 'detail-output',
    })
    click('关闭')
    hooks.dispose()
    pending.resolve({ record })
    await flushPromises()
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onChanged).toHaveBeenCalledTimes(1)
    expect(toast.success).not.toHaveBeenCalled()
  })
})
