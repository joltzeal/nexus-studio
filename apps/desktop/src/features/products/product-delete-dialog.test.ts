import type { DependencyList, EffectCallback } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProductSummarySchema } from '@nexus/plugin-products/contracts'
import { AlertDialogAction } from '@/components/ui/alert-dialog'
import {
  components,
  flushPromises,
  KernelHookHarness,
  text,
} from '@/features/settings/kernel-test-support'
import { removeProduct } from './api'
import { ProductDeleteDialog } from './product-delete-dialog'

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
    useEffect: (effect: EffectCallback, deps?: DependencyList) =>
      state.hooks ? state.hooks.effect(effect, deps) : react.useEffect(effect, deps),
  }
})
vi.mock('./api', () => ({ removeProduct: vi.fn() }))

let hooks: KernelHookHarness
beforeEach(() => {
  vi.resetAllMocks()
  hooks = new KernelHookHarness(state)
})
afterEach(() => hooks.dispose())

it('retains the confirmation with a visible revision conflict instead of reporting deletion', async () => {
  const product = ProductSummarySchema.parse({
    id: '741204de-e426-4a97-9d1a-a8b420e6eac4',
    name: 'Changed elsewhere',
    revision: 7,
    sequence: 1,
    cover: null,
    imageCount: 0,
    publicationCount: 0,
    latestPublication: null,
    source: { kind: 'manual' },
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: '2026-11-13T00:00:00.000Z',
  })
  const onClose = vi.fn()
  const onDeleted = vi.fn()
  const render = () =>
    hooks.render(() => ProductDeleteDialog({ product, onClose, onDeleted }))
  render()
  hooks.flushEffects()
  vi.mocked(removeProduct).mockRejectedValueOnce(new Error('修订冲突，请刷新'))
  const preventDefault = vi.fn()
  components(render(), AlertDialogAction)[0]!.props.onClick?.({
    preventDefault,
  } as unknown as React.MouseEvent<HTMLButtonElement>)
  await flushPromises()

  expect(preventDefault).toHaveBeenCalledOnce()
  expect(removeProduct).toHaveBeenCalledExactlyOnceWith({ id: product.id, revision: 7 })
  expect(text(render())).toContain('修订冲突，请刷新')
  expect(onDeleted).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
})
